import { adresseRappel, pointKeycloak, verifierJeton } from "../../../../auth/connexion.ts";
import { connexionOuverte, lireConfiguration } from "../../../../auth/configuration.ts";
import { COOKIE_TRANSACTION, DUREE_SESSION, cookieEffacer, cookieSession, lireCookie, magasin } from "../../../../auth/session.ts";

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
    const j = reponse.ok ? ((await reponse.json()) as Record<string, unknown>) : {};
    const [identite, acces, rafraichissement] = [j["id_token"], j["access_token"], j["refresh_token"]];
    if (typeof identite !== "string" || typeof acces !== "string" || typeof rafraichissement !== "string") return refus();
    const cles = async () => {
      const r = await fetch(pointKeycloak(config, "certs"), { redirect: "error", signal: AbortSignal.timeout(DELAI) });
      if (!r.ok) throw new Error("clés du royaume indisponibles");
      return ((await r.json()) as { keys: never[] }).keys;
    };
    const qui = await verifierJeton(identite, { ...config, nonce: transaction.nonce, maintenant: Date.now(), cles });
    const expireDans = typeof j["expires_in"] === "number" ? j["expires_in"] : 60;
    const session = magasin.ouvrirSession({ ...qui, jetonIdentite: identite, jetonAcces: acces, jetonRafraichissement: rafraichissement, accesExpireA: Date.now() + expireDans * 1000 });
    const entetes = new Headers(ENTETES);
    // Redirection directe : le cookie est Lax, il part avec la navigation qui suit.
    entetes.set("Location", transaction.retour);
    entetes.append("Set-Cookie", cookieSession(session.id, Math.floor(DUREE_SESSION / 1000)));
    entetes.append("Set-Cookie", cookieEffacer(COOKIE_TRANSACTION));
    return new Response(null, { status: 302, headers: entetes });
  } catch {
    return refus();
  }
}
