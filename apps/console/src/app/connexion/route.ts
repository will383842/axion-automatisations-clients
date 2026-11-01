import { adresseAutorisation, creerDefi, loginHintValide, retourSur } from "../../lib/connexion.ts";
import { connexionOuverte, lireConfiguration } from "../../lib/configuration.ts";
import { cookieTransaction, magasin } from "../../lib/session.ts";

// Aucun journal ici : l'adresse locale porte login_hint (une adresse e-mail), elle n'est jamais écrite.
const ENTETES = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export function GET(requete: Request): Response {
  if (!connexionOuverte()) return new Response("Non disponible", { status: 404, headers: ENTETES });
  const q = new URL(requete.url).searchParams;
  const indices = q.getAll("login_hint");
  if (indices.length > 1 || (indices[0] !== undefined && !loginHintValide(indices[0]))) return new Response("Adresse de connexion invalide", { status: 400, headers: ENTETES });
  const config = lireConfiguration();
  const defi = creerDefi();
  const etat = magasin.ouvrirTransaction({ verifier: defi.verifier, nonce: defi.nonce, retour: retourSur(q.get("retour")) });
  if (!etat) return new Response("Service saturé, réessayez dans un instant", { status: 503, headers: { ...ENTETES, "Retry-After": "60" } });
  const adresse = adresseAutorisation({ emetteur: config.emetteur, clientId: config.clientId, origine: config.origine }, { ...defi, state: etat }, indices[0]);
  const entetes = new Headers(ENTETES);
  entetes.set("Location", adresse);
  entetes.append("Set-Cookie", cookieTransaction(etat));
  return new Response(null, { status: 302, headers: entetes });
}
