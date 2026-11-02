import { createHmac, timingSafeEqual } from "node:crypto";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";

// Jeton d'instance (C-017) : ji1.<base64url(JSON {v,instanceId,cellule,exp})>.<base64url(HMAC-SHA256)>. Ce n'est PAS un JWT.
// Clé : canal « ji » du coffre, distincte de la clé HMAC de la cellule (c4-<cellule>) qui signe les requêtes. Durée 24 h, exp en secondes.
export const DUREE_JETON_MS = 24 * 3600_000;
const PREFIXE = "ji1";
const TAILLE_MAX = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CELLULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CLES = ["cellule", "exp", "instanceId", "v"];

export interface ChargeJetonInstance { v: 1; instanceId: string; cellule: string; exp: number }
export type Portee = Pick<ChargeJetonInstance, "instanceId" | "cellule">;
export interface ClesJi {
  cleActive(canal: string, sens: Sens): Promise<CleEchange>;
  clesAcceptees(canal: string, sens: Sens): Promise<CleEchange[]>;
}

const celluleValide = (c: unknown): c is string => typeof c === "string" && c.length <= 64 && CELLULE.test(c);
const signature = (cle: Buffer, texte: string) => createHmac("sha256", cle).update(texte).digest();

export async function emettreJetonInstance(cles: ClesJi, portee: Portee, maintenant: () => number = Date.now): Promise<string> {
  if (!UUID.test(portee.instanceId) || !celluleValide(portee.cellule)) throw new Error("jeton d'instance : instance ou cellule invalide");
  const cle = await cles.cleActive("ji", "emission");
  const charge: ChargeJetonInstance = { v: 1, instanceId: portee.instanceId, cellule: portee.cellule, exp: Math.floor((maintenant() + DUREE_JETON_MS) / 1000) };
  const corps = `${PREFIXE}.${Buffer.from(JSON.stringify(charge)).toString("base64url")}`;
  return `${corps}.${signature(cle.secret, corps).toString("base64url")}`;
}

// Rend la charge si le jeton est valide ET porte sur l'instance et la cellule attendues ; sinon null (aucune raison donnée).
export async function verifierJetonInstance(cles: ClesJi, jeton: string, attendu: Portee, maintenant: () => number = Date.now): Promise<ChargeJetonInstance | null> {
  if (typeof jeton !== "string" || jeton.length > TAILLE_MAX) return null;
  const parties = jeton.split(".");
  const [prefixe, brut, sig] = parties;
  if (parties.length !== 3 || prefixe !== PREFIXE || !brut || !sig || !BASE64URL.test(brut) || !BASE64URL.test(sig)) return null;
  const recue = Buffer.from(sig, "base64url");
  const corps = `${prefixe}.${brut}`;
  // Toutes les clés acceptées sont essayées sans sortie anticipée ; chaque comparaison suit un contrôle de longueur.
  let signee = false;
  for (const cle of await cles.clesAcceptees("ji", "emission")) {
    const attendue = signature(cle.secret, corps);
    if (recue.length === attendue.length && timingSafeEqual(recue, attendue)) signee = true;
  }
  if (!signee) return null;
  let charge: unknown;
  try {
    charge = JSON.parse(Buffer.from(brut, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof charge !== "object" || charge === null || Array.isArray(charge) || Object.keys(charge).sort().join() !== CLES.join()) return null;
  const c = charge as Record<string, unknown>;
  if (c["v"] !== 1 || typeof c["instanceId"] !== "string" || !UUID.test(c["instanceId"]) || !celluleValide(c["cellule"]) || !Number.isSafeInteger(c["exp"])) return null;
  if (maintenant() >= (c["exp"] as number) * 1000) return null;
  if (c["instanceId"].toLowerCase() !== attendu.instanceId.toLowerCase() || c["cellule"] !== attendu.cellule) return null;
  return { v: 1, instanceId: c["instanceId"], cellule: c["cellule"], exp: c["exp"] as number };
}
