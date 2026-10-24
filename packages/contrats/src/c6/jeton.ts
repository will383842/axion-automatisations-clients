import { createHmac, randomUUID } from "node:crypto";

// Lien signé de connexion de l'équipe (C6, annexe A). Le back-office d'axion-ia copie cette fonction
// (lot 2-bis) et prouve par l'empreinte des fixtures qu'elle est identique.
// Lien : https://auto.axion-ia.com/entree#j=<jeton> (le jeton est dans le fragment, jamais dans la requête).
export const DUREE_SECONDES = 60;
export const VERSION_JETON = 1;

export function signerCharge(secret: string, charge: string): string {
  return createHmac("sha256", secret).update(charge).digest("base64url");
}

// `maintenant` : secondes Unix. Renvoie base64url(charge) + "." + base64url(HMAC-SHA256 de la charge encodée).
export function emettreJeton(secret: string, kid: string, email: string, maintenant: number): string {
  const charge = Buffer.from(JSON.stringify({ v: VERSION_JETON, kid, jti: randomUUID(), email, iat: maintenant, exp: maintenant + DUREE_SECONDES })).toString("base64url");
  return `${charge}.${signerCharge(secret, charge)}`;
}
