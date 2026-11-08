import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";

// Connexion OIDC du portail : code d'autorisation + PKCE S256, state et nonce à usage unique (ADR 0132).
// Le rôle et l'organisation viennent des revendications SIGNÉES du jeton d'identité (roles_portail, organisations), jamais d'un attribut ni d'une requête.
export interface Cadre { emetteur: string; clientId: string; origine: string }
export interface Defi { verifier: string; challenge: string; state: string; nonce: string }
const aleatoire = () => randomBytes(32).toString("base64url");

export const ROLES = ["administrateur", "utilisateur", "lecture_seule", "comptable"] as const;
export type RoleClient = (typeof ROLES)[number];

export function creerDefi(): Defi {
  const verifier = aleatoire();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: aleatoire(), nonce: aleatoire() };
}

export const adresseRappel = (c: Pick<Cadre, "origine">) => `${c.origine}/api/auth/rappel`;
export const pointKeycloak = (c: Pick<Cadre, "emetteur">, chemin: "auth" | "token" | "certs" | "logout") => `${c.emetteur}/protocol/openid-connect/${chemin}`;

// Ni prompt=login ni max_age=0 : la session Keycloak du client peut resservir (le double facteur est l'objet de T6-03).
export function adresseAutorisation(c: Cadre, d: Defi): string {
  const p = new URLSearchParams({ response_type: "code", client_id: c.clientId, redirect_uri: adresseRappel(c), scope: "openid", state: d.state, nonce: d.nonce, code_challenge: d.challenge, code_challenge_method: "S256" });
  return `${pointKeycloak(c, "auth")}?${p.toString()}`;
}

// Retour : un chemin local seulement, hors /api/auth (pas de boucle) ; sinon l'accueil.
export function retourSur(v: string | null): string {
  if (!v || !/^\/(?![/\\])[^\\\p{Cc}]*$/u.test(v)) return "/";
  try {
    const u = new URL(v, "https://local.invalid");
    if (/[\\\p{Cc}]/u.test(decodeURIComponent(v))) return "/";
    const exclu = /^\/api\/auth(?:\/|$)/;
    if (u.origin !== "https://local.invalid" || exclu.test(u.pathname) || exclu.test(decodeURIComponent(u.pathname))) return "/";
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
export interface Identite { sub: string; role: RoleClient; organisation: string }
const decoder = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;
const GROUPE = /^\/organisations\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

// Vérifie le jeton d'identité : signature RS256, émetteur (royaume des clients), audience, azp, expiration, nonce ;
// puis exactement UN rôle de la liste fermée et exactement UN groupe /organisations/{uuid v4}.
export async function verifierJeton(jeton: string, a: Attendu): Promise<Identite> {
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
  if (typeof c["sub"] !== "string" || !c["sub"]) throw new Error("identité absente");
  const roles = c["roles_portail"];
  const role = Array.isArray(roles) && roles.length === 1 ? ROLES.find((r) => r === roles[0]) : undefined;
  if (!role) throw new Error("rôle refusé");
  const groupes = c["organisations"];
  const organisation = Array.isArray(groupes) && groupes.length === 1 && typeof groupes[0] === "string" ? GROUPE.exec(groupes[0])?.[1] : undefined;
  if (!organisation) throw new Error("organisation refusée");
  return { sub: c["sub"], role, organisation };
}
