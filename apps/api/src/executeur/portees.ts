import type { Pool } from "pg";
import { avecClient, avecEquipe, type Appelant } from "../db/client-actif.js";

// Portées d'une instance pour l'API de l'exécuteur (C-017). Le tenant_id vient TOUJOURS de la base, jamais de la requête.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CELLULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type EtatVoulu = "actif" | "pause" | "arrete";
// État console → état voulu (C4) : une erreur met en pause, une instance livrée s'arrête.
export const ETAT_VOULU_DE: Readonly<Record<"active" | "pause" | "erreur" | "livree", EtatVoulu>> = Object.freeze({ active: "actif", pause: "pause", erreur: "pause", livree: "arrete" });

export type EtatConsole = keyof typeof ETAT_VOULU_DE;
// Relue à CHAQUE requête : le jeton d'instance n'est ni révocable ni anti-rejeu, la base seule dit l'état, l'arrêt des envois et la cellule.
export interface InstanceResolue { tenantId: string; celluleCode: string | null; etat: EtatConsole; arretEnvois: boolean; version: number }

// Lecture seule par le pool de l'équipe. instances.id n'est pas unique seul (dette) : zéro ou plusieurs lignes = introuvable, sans distinction.
export async function resoudreInstance(poolEquipe: Pool, instanceId: string): Promise<InstanceResolue | null> {
  if (typeof instanceId !== "string" || !UUID.test(instanceId)) return null;
  const { rows } = await avecEquipe(poolEquipe, (c) => c.query("SELECT tenant_id, cellule_code, etat, arret_envois, version_etat_voulu FROM instances WHERE id = $1 LIMIT 2", [instanceId]));
  if (rows.length !== 1) return null;
  const ligne = rows[0] as { tenant_id: string; cellule_code: string | null; etat: string; arret_envois: boolean; version_etat_voulu: number };
  if (!Object.hasOwn(ETAT_VOULU_DE, ligne.etat)) return null;
  return { tenantId: ligne.tenant_id, celluleCode: ligne.cellule_code, etat: ligne.etat as EtatConsole, arretEnvois: ligne.arret_envois, version: ligne.version_etat_voulu };
}

// Attribution (ou retrait, avec null) d'une cellule : sous le client de l'instance, journalisée par l'acteur. Rend vrai si une ligne a changé.
export async function attribuerCellule(pool: Pool, cible: { tenantId: string; instanceId: string; cellule: string | null }, appelant: Appelant): Promise<boolean> {
  if (!UUID.test(cible.instanceId)) throw new Error("identifiant d'instance invalide");
  if (cible.cellule !== null && (cible.cellule.length > 64 || !CELLULE.test(cible.cellule))) throw new Error("code de cellule invalide");
  return avecClient(pool, cible.tenantId, async (c) => (await c.query("UPDATE instances SET cellule_code = $3 WHERE tenant_id = $1 AND id = $2", [cible.tenantId, cible.instanceId, cible.cellule])).rowCount === 1, appelant);
}
