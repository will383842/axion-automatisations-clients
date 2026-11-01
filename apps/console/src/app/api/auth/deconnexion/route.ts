import { pointKeycloak } from "../../../../lib/connexion.ts";
import { connexionOuverte, lireConfiguration } from "../../../../lib/configuration.ts";
import { COOKIE_SESSION, cookieEffacer, magasin, sessionDe } from "../../../../lib/session.ts";

const ENTETES = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export function POST(requete: Request): Response {
  if (!connexionOuverte()) return new Response("Non disponible", { status: 404, headers: ENTETES });
  const config = lireConfiguration();
  if (requete.headers.get("origin") !== config.origine) return new Response("Refusé", { status: 403, headers: ENTETES });
  const session = sessionDe(requete);
  if (session) magasin.fermerSession(session.id);
  const fin = new URL(pointKeycloak(config, "logout"));
  if (session) fin.searchParams.set("id_token_hint", session.jeton);
  fin.searchParams.set("post_logout_redirect_uri", `${config.origine}/`);
  const entetes = new Headers(ENTETES);
  entetes.set("Location", fin.href);
  entetes.append("Set-Cookie", cookieEffacer(COOKIE_SESSION));
  return new Response(null, { status: 303, headers: entetes });
}
