import { adresseRappel, pointKeycloak, verifierJeton } from "../../../../lib/connexion.ts";
import { connexionOuverte, lireConfiguration } from "../../../../lib/configuration.ts";
import { COOKIE_TRANSACTION, DUREE_SESSION, cookieEffacer, cookieSession, lireCookie, magasin } from "../../../../lib/session.ts";

const ENTETES = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const refus = () => new Response("Connexion refusée. Recommencez depuis la page de connexion.", { status: 403, headers: { ...ENTETES, "Set-Cookie": cookieEffacer(COOKIE_TRANSACTION) } });
const DELAI = 10_000;
const echapper = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
// Page de relais : Keycloak est un autre site, une redirection 302 partie de lui n'enverrait pas le cookie Strict. Cette page pose le cookie,
// puis la navigation vers le chemin demandé part de la console elle-même (meta refresh, aucun script).
const relais = (retour: string) => {
  const cible = echapper(retour);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${cible}"><meta name="referrer" content="no-referrer"><title>Connexion</title></head><body><p>Connexion réussie. <a href="${cible}">Continuer</a></p></body></html>`;
};

export async function GET(requete: Request): Promise<Response> {
  if (!connexionOuverte()) return new Response("Non disponible", { status: 404, headers: ENTETES });
  const q = new URL(requete.url).searchParams;
  const etat = q.get("state");
  // Le state doit être celui du cookie de CE navigateur ; la transaction ne sert qu'une fois, même si la suite échoue.
  const transaction = etat && etat === lireCookie(requete.headers.get("cookie"), COOKIE_TRANSACTION) ? magasin.consommerTransaction(etat) : undefined;
  const code = q.get("code");
  if (!transaction || q.has("error") || !code) return refus();
  const config = lireConfiguration();
  try {
    const reponse = await fetch(pointKeycloak(config, "token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: adresseRappel(config), client_id: config.clientId, client_secret: config.secret, code_verifier: transaction.verifier }),
      redirect: "error",
      signal: AbortSignal.timeout(DELAI),
    });
    const jeton = reponse.ok ? ((await reponse.json()) as { id_token?: unknown }).id_token : undefined;
    if (typeof jeton !== "string") return refus();
    const cles = async () => {
      const r = await fetch(pointKeycloak(config, "certs"), { redirect: "error", signal: AbortSignal.timeout(DELAI) });
      if (!r.ok) throw new Error("clés du royaume indisponibles");
      return ((await r.json()) as { keys: never[] }).keys;
    };
    const identite = await verifierJeton(jeton, { ...config, nonce: transaction.nonce, maintenant: Date.now(), cles });
    const session = magasin.ouvrirSession({ sub: identite.sub, email: identite.email, jeton });
    const entetes = new Headers(ENTETES);
    entetes.set("Content-Type", "text/html; charset=utf-8");
    entetes.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'");
    entetes.append("Set-Cookie", cookieSession(session.id, Math.floor(DUREE_SESSION / 1000)));
    entetes.append("Set-Cookie", cookieEffacer(COOKIE_TRANSACTION));
    return new Response(relais(transaction.retour), { status: 200, headers: entetes });
  } catch {
    return refus();
  }
}
