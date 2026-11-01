import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";

// Connexion OIDC de l'équipe : code d'autorisation + PKCE S256, state et nonce à usage unique (ADR 0056).
export interface Cadre { emetteur: string; clientId: string; origine: string }
export interface Defi { verifier: string; challenge: string; state: string; nonce: string }
const aleatoire = () => randomBytes(32).toString("base64url");

export function creerDefi(): Defi {
  const verifier = aleatoire();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: aleatoire(), nonce: aleatoire() };
}

export const adresseRappel = (c: Pick<Cadre, "origine">) => `${c.origine}/api/auth/rappel`;
export const pointKeycloak = (c: Pick<Cadre, "emetteur">, chemin: "auth" | "token" | "certs" | "logout") => `${c.emetteur}/protocol/openid-connect/${chemin}`;

export function adresseAutorisation(c: Cadre, d: Defi, loginHint?: string): string {
  const p = new URLSearchParams({ response_type: "code", client_id: c.clientId, redirect_uri: adresseRappel(c), scope: "openid", state: d.state, nonce: d.nonce, code_challenge: d.challenge, code_challenge_method: "S256", prompt: "login", max_age: "0", acr_values: "mfa" });
  if (loginHint) p.set("login_hint", loginHint);
  return `${pointKeycloak(c, "auth")}?${p.toString()}`;
}

// login_hint : même forme que le contrat C6 (un lien signé valide ne doit jamais être refusé ici), avec 254 caractères au plus.
// Pas d'espace, de contrôle, de `"`, `<`, `>` ni `&` ; l'adresse est de toute façon encodée par URLSearchParams.
const EMAIL = /^[^\s@"<>&\p{Cc}\p{Cf}]{1,64}@[^\s@"<>&\p{Cc}\p{Cf}]{1,255}$/u;
export const loginHintValide = (v: string): boolean => v.length <= 254 && EMAIL.test(v);

// Retour : un chemin local seulement, hors pages de connexion (pas de boucle) ; sinon l'accueil.
export function retourSur(v: string | null): string {
  if (!v || !/^\/(?![/\\])[^\\\p{Cc}]*$/u.test(v)) return "/";
  try {
    const u = new URL(v, "https://local.invalid");
    // Une fois décodé, le chemin ne doit contenir ni contrôle ni barre oblique inverse (%0d%0a, %5c).
    if (/[\\\p{Cc}]/u.test(decodeURIComponent(v))) return "/";
    if (u.origin !== "https://local.invalid" || /^\/(?:connexion|entree|api\/auth)(?:\/|$)/.test(u.pathname)) return "/";
  } catch {
    return "/";
  }
  return v;
}

export interface Attendu extends Cadre {
  nonce: string;
  maintenant: number; // millisecondes
  cles: () => Promise<Array<JsonWebKey & { kid?: string }>>;
}
const FRAICHEUR = 300; // secondes : le double facteur vient d'être passé
const SECOND_FACTEUR = new Set(["otp", "webauthn", "hwk", "mfa"]);
const decoder = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

// Vérifie le jeton d'identité : signature RS256, émetteur (royaume), audience, expiration, nonce, fraîcheur et double facteur (acr + amr).
export async function verifierJeton(jeton: string, a: Attendu): Promise<{ sub: string; email: string }> {
  const morceaux = jeton.split(".");
  if (morceaux.length !== 3 || !morceaux[0] || !morceaux[1] || !morceaux[2]) throw new Error("jeton mal formé");
  const entete = decoder(morceaux[0]);
  if (entete["alg"] !== "RS256") throw new Error("algorithme refusé");
  const cle = (await a.cles()).find((k) => k.kty === "RSA" && k["use"] !== "enc" && (k.kid === entete["kid"] || !entete["kid"]));
  if (!cle || !verify("sha256", Buffer.from(`${morceaux[0]}.${morceaux[1]}`), createPublicKey({ key: cle, format: "jwk" }), Buffer.from(morceaux[2], "base64url"))) throw new Error("signature refusée");
  const c = decoder(morceaux[1]);
  const t = Math.floor(a.maintenant / 1000);
  const aud = ([] as unknown[]).concat(c["aud"]);
  if (c["iss"] !== a.emetteur) throw new Error("iss refusé");
  if (!aud.includes(a.clientId)) throw new Error("aud refusé");
  if ((aud.length > 1 || c["azp"] !== undefined) && c["azp"] !== a.clientId) throw new Error("azp refusé");
  if (typeof c["exp"] !== "number" || c["exp"] <= t) throw new Error("exp dépassé");
  if (c["nonce"] !== a.nonce) throw new Error("nonce refusé");
  if (typeof c["auth_time"] !== "number" || c["auth_time"] < t - FRAICHEUR || c["auth_time"] > t + 60) throw new Error("auth_time trop ancien");
  if (c["acr"] !== "mfa") throw new Error("acr sans double facteur");
  // Le royaume livré n'émet pas encore `amr` (ADR 0056) : absent, il ne bloque pas, `acr=mfa` faisant foi ; présent, il doit nommer un second facteur.
  if (c["amr"] !== undefined && (!Array.isArray(c["amr"]) || !c["amr"].some((m) => SECOND_FACTEUR.has(String(m))))) throw new Error("amr sans second facteur");
  if (typeof c["sub"] !== "string" || !c["sub"]) throw new Error("identité absente");
  // L'identité de la session est `sub` ; l'e-mail est facultatif (affichage seulement) et gardé s'il a une forme valide.
  return { sub: c["sub"], email: typeof c["email"] === "string" && loginHintValide(c["email"]) ? c["email"] : "" };
}
