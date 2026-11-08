import { pointKeycloak } from "../../../../auth/connexion.ts";
import { connexionOuverte, lireConfiguration } from "../../../../auth/configuration.ts";
import { COOKIE_SESSION, cookieEffacer, magasin, sessionDe } from "../../../../auth/session.ts";

const ENTETES = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const DELAI = 10_000;

export async function POST(requete: Request): Promise<Response> {
  if (!connexionOuverte()) return new Response("Non disponible", { status: 404, headers: ENTETES });
  const config = lireConfiguration();
  if (requete.headers.get("origin") !== config.origine) return new Response("Refusé", { status: 403, headers: ENTETES });
  const session = sessionDe(requete);
  if (session) {
    magasin.fermerSession(session.id);
    // Révocation côté Keycloak : la session de Keycloak est close avec le jeton de rafraîchissement. Un échec n'empêche pas la déconnexion locale.
    try {
      await fetch(pointKeycloak(config, "logout"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.secret, refresh_token: session.jetonRafraichissement }),
        redirect: "error",
        signal: AbortSignal.timeout(DELAI),
      });
    } catch {
      // le jeton d'accès reste valable au plus 300 s (limite écrite dans l'ADR 0132)
    }
  }
  const fin = new URL(pointKeycloak(config, "logout"));
  // client_id toujours présent : sans session il n'y a pas d'id_token_hint, et Keycloak refuse alors post_logout_redirect_uri.
  fin.searchParams.set("client_id", config.clientId);
  if (session) fin.searchParams.set("id_token_hint", session.jetonIdentite);
  fin.searchParams.set("post_logout_redirect_uri", `${config.origine}/`);
  const entetes = new Headers(ENTETES);
  entetes.set("Location", fin.href);
  entetes.append("Set-Cookie", cookieEffacer(COOKIE_SESSION));
  return new Response(null, { status: 303, headers: entetes });
}
