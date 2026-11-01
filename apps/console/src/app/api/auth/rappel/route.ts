import { adresseRappel, pointKeycloak, verifierJeton } from "../../../../lib/connexion.ts";
import { connexionOuverte, lireConfiguration } from "../../../../lib/configuration.ts";
import { COOKIE_TRANSACTION, cookieEffacer, cookieSession, lireCookie, magasin } from "../../../../lib/session.ts";

const ENTETES = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const refus = () => new Response("Connexion refusée. Recommencez depuis la page de connexion.", { status: 403, headers: { ...ENTETES, "Set-Cookie": cookieEffacer(COOKIE_TRANSACTION) } });
const DELAI = 10_000;

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
    const cles = async () => ((await (await fetch(pointKeycloak(config, "certs"), { signal: AbortSignal.timeout(DELAI) })).json()) as { keys: never[] }).keys;
    const identite = await verifierJeton(jeton, { ...config, nonce: transaction.nonce, maintenant: Date.now(), cles });
    const session = magasin.ouvrirSession({ sub: identite.sub, email: identite.email, jeton, expireA: identite.exp * 1000 });
    const entetes = new Headers(ENTETES);
    entetes.set("Location", transaction.retour);
    entetes.append("Set-Cookie", cookieSession(session.id, Math.floor((session.expireA - Date.now()) / 1000)));
    entetes.append("Set-Cookie", cookieEffacer(COOKIE_TRANSACTION));
    return new Response(null, { status: 302, headers: entetes });
  } catch {
    return refus();
  }
}
