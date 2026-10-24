import { createHmac, randomUUID } from "node:crypto";

// Lien signé de connexion de l'équipe (C6, annexe A). Le back-office d'axion-ia copie cette fonction
// (lot 2-bis) et prouve par l'empreinte des fixtures qu'elle est identique.
// Lien : https://auto.axion-ia.com/entree#j=<jeton> (le jeton est dans le fragment, jamais dans la requête).
export const DUREE_SECONDES = 60;
export const VERSION_JETON = 1;
export const CLE_OCTETS_MIN = 32;

// CONTRAT : le secret est une chaîne UTF-8, utilisée telle quelle comme clé HMAC (jamais décodée
// en hexadécimal ni en base64). Il fait au moins 32 octets UTF-8. Le `kid` des clés C6 porte le
// préfixe `c6-` et ces clés ne servent à aucun autre usage : la charge n'a pas de champ d'usage.
export const PREFIXE_KID = "c6-";

export function cleValide(secret: string): boolean {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= CLE_OCTETS_MIN;
}

export function signerCharge(secret: string, charge: string): string {
  return createHmac("sha256", secret).update(charge).digest("base64url");
}

// `maintenant` : secondes Unix. Renvoie base64url(charge) + "." + base64url(HMAC-SHA256 de la charge encodée).
export function emettreJeton(secret: string, kid: string, email: string, maintenant: number): string {
  if (!cleValide(secret)) throw new Error("clé C6 trop courte");
  if (!Number.isSafeInteger(maintenant)) throw new Error("heure invalide");
  const charge = Buffer.from(JSON.stringify({ v: VERSION_JETON, kid, jti: randomUUID(), email, iat: maintenant, exp: maintenant + DUREE_SECONDES })).toString("base64url");
  return `${charge}.${signerCharge(secret, charge)}`;
}
