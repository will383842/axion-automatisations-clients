import { ErreurConnecteur } from "@axion-auto/connecteurs-commun";

export type ContexteErreur = { maintenant: number; attenteQuotaMs: number };

const COUPURES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ECONNECTION", "ESOCKET", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "NoConnection", "EndOfStream"]);
const lire = (e: unknown, cle: string): unknown => (typeof e === "object" && e !== null ? (e as Record<string, unknown>)[cle] : undefined);

// Les erreurs d'imapflow et de nodemailer deviennent une des 4 classes. Le texte du serveur n'est jamais recopié : seul le code sort.
export function classerServeur(e: unknown, ctx: ContexteErreur): ErreurConnecteur {
  if (e instanceof ErreurConnecteur) return e;
  const code = lire(e, "code");
  const reponse = lire(e, "responseCode");
  const serveur = String(lire(e, "serverResponseCode") ?? "");
  const texte = String(lire(e, "responseText") ?? "");
  if (lire(e, "authenticationFailed") === true || serveur === "AUTHENTICATIONFAILED" || code === "EAUTH" || reponse === 535) {
    return new ErreurConnecteur("identification", "identification_refusee");
  }
  if (serveur === "OVERQUOTA" || texte.includes("[OVERQUOTA]") || reponse === 421 || reponse === 452) {
    return new ErreurConnecteur("quota", "quota_depasse", { reprise: new Date(ctx.maintenant + ctx.attenteQuotaMs).toISOString() });
  }
  if (typeof code === "string" && COUPURES.has(code)) return new ErreurConnecteur("passagere", "coupure");
  if (typeof reponse === "number") return new ErreurConnecteur(reponse >= 400 && reponse < 500 ? "passagere" : "definitive", reponse >= 400 && reponse < 500 ? "refus_temporaire" : "refus_serveur");
  return new ErreurConnecteur("definitive", "inattendue");
}
