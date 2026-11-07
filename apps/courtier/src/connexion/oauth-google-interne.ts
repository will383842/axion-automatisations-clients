import { lireIdToken, lireReponseJeton, type JetonsRecus } from "./oauth-microsoft.js";
import { avecDelai, DELAI_TEST_MS } from "./tester.js";
import { defiPkce, ErreurConnexion, type Transaction } from "./transactions.js";

// Application interne créée dans le compte Workspace du client. Aucune adresse de fournisseur ne vient de la requête.
export interface ConfigGoogle {
  redirectUri: string;
  portees: readonly string[];
  hoteAutorisation?: string;
  hoteJeton?: string;
  hoteApi?: string;
  delaiMs?: number;
}
export interface ApplicationGoogle { client_id: string; client_secret: string }

export function adresseAutorisation(tx: Transaction, app: Pick<ApplicationGoogle, "client_id">, cfg: ConfigGoogle): string {
  if (tx.fournisseur !== "google") throw new ErreurConnexion("lien_invalide");
  const u = new URL(`${cfg.hoteAutorisation ?? "https://accounts.google.com"}/o/oauth2/v2/auth`);
  const q = u.searchParams;
  q.set("client_id", app.client_id);
  q.set("response_type", "code");
  q.set("redirect_uri", cfg.redirectUri);
  q.set("scope", [...cfg.portees, "openid", "email"].join(" "));
  q.set("state", tx.state);
  q.set("nonce", tx.nonce);
  q.set("code_challenge", defiPkce(tx.verifier));
  q.set("code_challenge_method", "S256");
  q.set("access_type", "offline");
  q.set("prompt", "consent");
  return u.toString();
}

export async function echanger(fetchFn: typeof fetch, tx: Transaction, code: string, app: ApplicationGoogle, cfg: ConfigGoogle): Promise<JetonsRecus> {
  if (tx.fournisseur !== "google" || !tx.domaine) throw new ErreurConnexion("lien_invalide");
  if (!tx.verifier) throw new ErreurConnexion("pkce_absent");
  const corps = new URLSearchParams({ grant_type: "authorization_code", client_id: app.client_id, client_secret: app.client_secret, code, redirect_uri: cfg.redirectUri, code_verifier: tx.verifier });
  let r: Response;
  try {
    r = await avecDelai((signal) => fetchFn(`${cfg.hoteJeton ?? "https://oauth2.googleapis.com"}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: corps, signal }), cfg.delaiMs ?? DELAI_TEST_MS);
  } catch {
    throw new ErreurConnexion("fournisseur_indisponible");
  }
  const o = await lireReponseJeton(r);
  const charge = lireIdToken(o["id_token"]);
  const hd = typeof charge?.["hd"] === "string" ? charge["hd"].toLowerCase() : undefined;
  // Domaine Workspace reçu absent ou différent du domaine attendu : rien n'est écrit.
  if (!charge || !hd || hd !== tx.domaine.toLowerCase()) throw new ErreurConnexion("mauvais_compte");
  const acces = o["access_token"];
  const renouvellement = o["refresh_token"];
  const duree = o["expires_in"];
  if (typeof acces !== "string" || typeof renouvellement !== "string" || typeof duree !== "number" || !(duree > 0)) throw new ErreurConnexion("refus_fournisseur");
  const compte: JetonsRecus["compte"] = { domaine: hd };
  if (typeof charge["sub"] === "string") compte.oid = charge["sub"];
  if (typeof charge["email"] === "string") compte.adresse = charge["email"];
  return { access_token: acces, refresh_token: renouvellement, expires_in: duree, compte };
}

