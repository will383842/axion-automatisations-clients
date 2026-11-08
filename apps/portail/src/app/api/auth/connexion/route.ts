import { adresseAutorisation, creerDefi, retourSur } from "../../../../auth/connexion.ts";
import { connexionOuverte, lireConfiguration } from "../../../../auth/configuration.ts";
import { cookieTransaction, magasin } from "../../../../auth/session.ts";

// Aucun journal ici : ni adresse de connexion ni jeton ne sont écrits.
const ENTETES = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export function GET(requete: Request): Response {
  if (!connexionOuverte()) return new Response("Non disponible", { status: 404, headers: ENTETES });
  const config = lireConfiguration();
  const defi = creerDefi();
  const etat = magasin.ouvrirTransaction({ verifier: defi.verifier, nonce: defi.nonce, retour: retourSur(new URL(requete.url).searchParams.get("retour")) });
  if (etat === undefined) return new Response("Service saturé, réessayez dans quelques minutes", { status: 503, headers: { ...ENTETES, "Retry-After": "60" } });
  const entetes = new Headers(ENTETES);
  entetes.set("Location", adresseAutorisation(config, { ...defi, state: etat }));
  entetes.append("Set-Cookie", cookieTransaction(etat));
  return new Response(null, { status: 302, headers: entetes });
}
