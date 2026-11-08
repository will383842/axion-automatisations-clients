import { gardeIndisponible, type ValkeyEnvois } from "./arret-urgence.ts";

// Compteurs d'envois par boîte (T4-45) dans Valkey. INCR et DECR sont atomiques : la place se RÉSERVE avant l'envoi et se rend si l'envoi n'a pas eu lieu.
// Un identifiant de boîte ou de client est validé avant de former une clé (aucune clé forgée).
const IDENTIFIANT = /^[A-Za-z0-9_.@-]{1,128}$/;
const DEUX_JOURS_S = 2 * 86_400;
const QUATRE_VINGT_DIX_JOURS_S = 90 * 86_400;

export interface BoiteCle { tenantId: string; boite: string }
function base(c: BoiteCle): string {
  if (!IDENTIFIANT.test(c.tenantId) || !IDENTIFIANT.test(c.boite)) throw gardeIndisponible();
  return `executeur:plafond:${c.tenantId}:${c.boite}`;
}
export const cleJour = (c: BoiteCle, jour: string) => `${base(c)}:j:${jour}`;
export const cleMinute = (c: BoiteCle, minute: string) => `${base(c)}:m:${minute}`;
export const cleAbaisse = (c: BoiteCle, jour: string) => `${base(c)}:abaisse:${jour}`;
export const clePremier = (c: BoiteCle) => `${base(c)}:premier`;
export const cleDernier = (c: BoiteCle) => `${base(c)}:dernier`;
// Compteur visible par l'équipe : envois reportés au jour suivant.
export const cleReportes = (c: BoiteCle, jour: string) => `${base(c)}:reportes:${jour}`;

const texte = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nombre = (v: unknown): number | undefined => (v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v));

export async function lire(valkey: ValkeyEnvois, cle: string): Promise<string | undefined> {
  return texte(await valkey.call("GET", cle));
}
export async function lireNombre(valkey: ValkeyEnvois, cle: string): Promise<number | undefined> {
  return nombre(await valkey.call("GET", cle));
}
export async function poser(valkey: ValkeyEnvois, cle: string, valeur: string, seulementSiAbsent = false): Promise<void> {
  await valkey.call("SET", cle, valeur, ...(seulementSiAbsent ? ["NX"] : []), "EX", String(QUATRE_VINGT_DIX_JOURS_S));
}
// Sans durée de vie : la date du premier envoi et celle du dernier envoi servent de repère à la montée, elles ne doivent jamais expirer pendant que la boîte envoie (ni, pour le silence, avant d'être comparées).
export async function poserDurable(valkey: ValkeyEnvois, cle: string, valeur: string, seulementSiAbsent = false): Promise<void> {
  await valkey.call("SET", cle, valeur, ...(seulementSiAbsent ? ["NX"] : []));
}
// Incrémente puis, au premier passage, donne une durée de vie au compteur.
export async function incrementer(valkey: ValkeyEnvois, cle: string, dureeS = DEUX_JOURS_S): Promise<number> {
  const n = Number(await valkey.call("INCR", cle));
  if (!Number.isInteger(n)) throw gardeIndisponible();
  if (n === 1) await valkey.call("EXPIRE", cle, String(dureeS));
  return n;
}
export async function decrementer(valkey: ValkeyEnvois, cle: string): Promise<void> {
  await valkey.call("DECR", cle);
}
