import { avecDelai, DELAI_TEST_MS } from "./tester.js";
import { defiPkce, ErreurConnexion, type Transaction } from "./transactions.js";

// Application multi-entreprises d'AXION IA. Le retour OAuth est une CONSTANTE de configuration : aucune adresse de retour ne vient de la requête.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConfigMicrosoft {
  clientId: string;
  redirectUri: string;
  portees: readonly string[];
  hote?: string;
  hoteApi?: string;
  delaiMs?: number;
  // Le secret de l'application vient d'un port et n'est jamais journalisé.
  secretApplication(): Promise<string>;
}
export interface JetonsRecus {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  compte: { tid?: string; oid?: string; adresse?: string; domaine?: string };
}

const HOTE = "https://login.microsoftonline.com";
const locataireDe = (tx: Transaction): string => {
  // Jamais common, organizations ni consumers : seulement un UUID de locataire.
  if (tx.fournisseur !== "microsoft" || !tx.locataire || !UUID.test(tx.locataire)) throw new ErreurConnexion("lien_invalide");
  return tx.locataire.toLowerCase();
};

export function adresseAutorisation(tx: Transaction, cfg: ConfigMicrosoft): string {
  const u = new URL(`${cfg.hote ?? HOTE}/${locataireDe(tx)}/oauth2/v2.0/authorize`);
  const q = u.searchParams;
  q.set("client_id", cfg.clientId);
  q.set("response_type", "code");
  q.set("redirect_uri", cfg.redirectUri);
  q.set("scope", [...cfg.portees, "openid", "offline_access"].join(" "));
  q.set("state", tx.state);
  q.set("nonce", tx.nonce);
  q.set("code_challenge", defiPkce(tx.verifier));
  q.set("code_challenge_method", "S256");
  q.set("prompt", "select_account");
  return u.toString();
}

export function adresseAccordAdmin(tx: Transaction, cfg: ConfigMicrosoft): string {
  const u = new URL(`${cfg.hote ?? HOTE}/${locataireDe(tx)}/v2.0/adminconsent`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("scope", "https://graph.microsoft.com/.default");
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", tx.state);
  return u.toString();
}

// Lecture de la charge d'un id_token reçu en TLS directement du point de jeton (pas de vérification de signature).
export function lireIdToken(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== "string") return null;
  const morceaux = idToken.split(".");
  if (morceaux.length !== 3) return null;
  try {
    const charge = JSON.parse(Buffer.from(morceaux[1] as string, "base64url").toString("utf8")) as unknown;
    return typeof charge === "object" && charge !== null && !Array.isArray(charge) ? (charge as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const texte = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 320 ? v : undefined);

// Codes fermés : error_description n'est lue que pour reconnaître le motif, jamais recopiée.
export function codeDeRefus(statut: number, corps: unknown): ErreurConnexion {
  const o = (typeof corps === "object" && corps !== null ? corps : {}) as Record<string, unknown>;
  const description = typeof o["error_description"] === "string" ? o["error_description"] : "";
  if (statut >= 500 || statut === 429) return new ErreurConnexion("fournisseur_indisponible");
  if (description.includes("AADSTS65001") || o["error"] === "consent_required") return new ErreurConnexion("accord_admin_requis");
  if (description.includes("AADSTS50020")) return new ErreurConnexion("mauvais_compte");
  return new ErreurConnexion("refus_fournisseur");
}

export async function lireReponseJeton(r: Response): Promise<Record<string, unknown>> {
  const corps = (await r.json().catch(() => ({}))) as unknown;
  if (!r.ok) throw codeDeRefus(r.status, corps);
  return (typeof corps === "object" && corps !== null ? corps : {}) as Record<string, unknown>;
}

export async function echanger(fetchFn: typeof fetch, tx: Transaction, code: string, cfg: ConfigMicrosoft): Promise<JetonsRecus> {
  const locataire = locataireDe(tx);
  if (!tx.verifier) throw new ErreurConnexion("pkce_absent");
  const secret = await cfg.secretApplication();
  const corps = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: secret,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: tx.verifier,
  });
  let r: Response;
  try {
    r = await avecDelai((signal) => fetchFn(`${cfg.hote ?? HOTE}/${locataire}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: corps, signal }), cfg.delaiMs ?? DELAI_TEST_MS);
  } catch {
    throw new ErreurConnexion("fournisseur_indisponible");
  }
  const o = await lireReponseJeton(r);
  const charge = lireIdToken(o["id_token"]);
  const tid = texte(charge?.["tid"]);
  // Locataire reçu absent ou différent du locataire attendu : rien n'est écrit.
  if (!charge || !tid || tid.toLowerCase() !== locataire) throw new ErreurConnexion("mauvais_compte");
  if (charge["nonce"] !== undefined && charge["nonce"] !== tx.nonce) throw new ErreurConnexion("refus_fournisseur");
  const acces = o["access_token"];
  const renouvellement = o["refresh_token"];
  const duree = o["expires_in"];
  if (typeof acces !== "string" || typeof renouvellement !== "string" || typeof duree !== "number" || !(duree > 0)) throw new ErreurConnexion("refus_fournisseur");
  const compte: JetonsRecus["compte"] = { tid: tid.toLowerCase() };
  const oid = texte(charge["oid"]);
  const adresse = texte(charge["preferred_username"]);
  if (oid) compte.oid = oid;
  if (adresse) compte.adresse = adresse;
  return { access_token: acces, refresh_token: renouvellement, expires_in: duree, compte };
}
