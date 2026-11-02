import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { avecClient } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { LigneAnnulation, ServiceAnnulation } from "../reversible/annuler.js";

// Versions des réglages (A-175, A-176, ADR 0054) : un réglage n'est jamais écrasé. Chaque modification insère une version (numéro + 1) et active
// la nouvelle ; une seule est active (index partiel). « Revenir » recopie les données d'une ancienne version dans une NOUVELLE version.
// Tout se passe dans UNE transaction avecClient (app.tenant_id et app.acteur posés) : le journal d'audit nomme l'auteur.
// Le verrou de ligne sur l'instance sérialise les modifications : deux appels simultanés donnent deux numéros successifs.
export interface VersionReglage {
  id: string;
  numero: number;
  donnees: Record<string, unknown>;
  auteur: string;
  motif: string;
  active: boolean;
}

// Résultat d'un retour arrière : cree=false quand la version active portait déjà ces données (rien n'a été écrit).
export type RetourReglage = VersionReglage & { cree: boolean };

const NUMERO_MAX = 2_147_483_647; // colonne integer
const MOTIF_MAX = 500;
const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function motifValide(motif: string): string {
  const m = typeof motif === "string" ? motif.trim() : "";
  if (m === "" || m.length > MOTIF_MAX) throw new ErreurApi("schema_invalide", "Motif obligatoire (1 à 500 caractères).");
  return m;
}

// Étapes 1 à 6, dans la transaction de l'appelant (utilisée aussi par l'annulation, qui doit rester dans la sienne).
export async function modifierDans(client: PoolClient, instance: string, donnees: unknown, auteur: string, motifBrut: string): Promise<VersionReglage> {
  const motif = motifValide(motifBrut);
  const inst = await client.query("SELECT v.schema_configuration, v.semver FROM instances AS i LEFT JOIN versions_automatisation AS v ON v.id = i.version_courante_id WHERE i.id = $1 FOR UPDATE OF i", [instance]);
  const ligne = inst.rows[0] as { schema_configuration: object | null; semver: string | null } | undefined;
  if (!ligne) throw new ErreurApi("introuvable", "Instance introuvable.");
  if (!ligne.schema_configuration || !ligne.semver) throw new ErreurApi("regle_metier", "Aucune version d'automatisation installée sur cette instance.");
  // Le schéma de configuration de la version courante fait foi (JSON Schema du catalogue, traduit en Zod).
  if (!estObjet(donnees) || !z.fromJSONSchema(ligne.schema_configuration as never).safeParse(donnees).success) throw new ErreurApi("schema_invalide", "Les données ne respectent pas le schéma de configuration.");
  const dernier = Number(((await client.query("SELECT coalesce(max(numero), 0) AS dernier FROM configurations WHERE instance_id = $1", [instance])).rows[0] as { dernier: number | string }).dernier);
  const numero = dernier + 1;
  if (!Number.isSafeInteger(numero) || numero > NUMERO_MAX) throw new ErreurApi("regle_metier", "Nombre de versions maximal atteint.");
  await client.query("UPDATE configurations SET active = false, active_par = $2 WHERE instance_id = $1 AND active", [instance, auteur]);
  const id = randomUUID();
  await client.query(
    "INSERT INTO configurations (tenant_id, id, instance_id, numero, donnees, version_schema, auteur, motif_changement) VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::jsonb, $5, $6, $7)",
    [id, instance, numero, JSON.stringify(donnees), ligne.semver, auteur, motif],
  );
  await client.query("UPDATE configurations SET active = true, active_par = $2 WHERE id = $1", [id, auteur]);
  return { id, numero, donnees, auteur, motif, active: true };
}

export function modifier(pool: Pool, tenantId: string, instance: string, donnees: unknown, auteur: string, motif: string): Promise<VersionReglage> {
  return avecClient(pool, tenantId, (c) => modifierDans(c, instance, donnees, auteur, motif), { acteur: auteur });
}

// Verrou de ligne sur l'instance (tenu jusqu'à la fin de la transaction) : sérialise modifications, retours et annulations.
async function verrouiller(client: PoolClient, instance: string): Promise<void> {
  if (!(await client.query("SELECT 1 FROM instances WHERE id = $1 FOR UPDATE", [instance])).rows[0]) throw new ErreurApi("introuvable", "Instance introuvable.");
}

export async function revenirDans(client: PoolClient, instance: string, numero: number, auteur: string, motif?: string): Promise<RetourReglage> {
  if (!Number.isSafeInteger(numero) || numero < 1) throw new ErreurApi("schema_invalide", "Numéro de version invalide.");
  // Verrou d'abord : toute lecture (version visée, version active) se fait sous le verrou de l'instance, jamais avant.
  await verrouiller(client, instance);
  const vue = await client.query("SELECT donnees FROM configurations WHERE instance_id = $1 AND numero = $2", [instance, numero]);
  const ancienne = vue.rows[0] as { donnees: Record<string, unknown> } | undefined;
  if (!ancienne) throw new ErreurApi("introuvable", "Version introuvable.");
  // Idempotence : si la version active porte déjà ces données, on la renvoie sans rien écrire (double clic, rejeu).
  const active = (await client.query("SELECT id, numero, donnees, auteur, motif_changement AS motif, active FROM configurations WHERE instance_id = $1 AND active", [instance])).rows[0] as VersionReglage | undefined;
  if (active && isDeepStrictEqual(active.donnees, ancienne.donnees)) return { ...active, cree: false };
  return { ...(await modifierDans(client, instance, ancienne.donnees, auteur, motif ?? `retour à la version ${numero}`)), cree: true };
}

export function revenir(pool: Pool, tenantId: string, instance: string, numero: number, auteur: string, motif?: string): Promise<RetourReglage> {
  return avecClient(pool, tenantId, (c) => revenirDans(c, instance, numero, auteur, motif), { acteur: auteur });
}

export function historique(pool: Pool, tenantId: string, instance: string): Promise<VersionReglage[]> {
  return avecClient(pool, tenantId, async (c) => {
    if (!(await c.query("SELECT 1 FROM instances AS i WHERE i.id = $1", [instance])).rows[0]) throw new ErreurApi("introuvable", "Instance introuvable.");
    const r = await c.query("SELECT id, numero, donnees, auteur, motif_changement AS motif, active FROM configurations WHERE instance_id = $1 ORDER BY numero DESC", [instance]);
    return r.rows as VersionReglage[];
  });
}

// Annulation d'une modification de réglage : seule l'INSERTION de la version active s'annule (retour à la version précédente, nouvelle version).
// Une version plus récente existe déjà → regle_metier : l'annuler perdrait les changements suivants.
export const serviceAnnulationReglages: ServiceAnnulation = {
  async annuler(client: PoolClient, ligne: LigneAnnulation, auteur: string) {
    const v = ligne.action === "insertion" && ligne.nouvelle ? (JSON.parse(ligne.nouvelle) as { instance_id?: unknown; numero?: unknown }) : null;
    if (!v || typeof v.instance_id !== "string" || typeof v.numero !== "number") throw new ErreurApi("action_interdite", "Ce changement ne s'annule pas.");
    await verrouiller(client, v.instance_id); // avant toute lecture de la version active : deux annulations simultanées se suivent
    const actuelle = (await client.query("SELECT numero FROM configurations WHERE instance_id = $1 AND active", [v.instance_id])).rows[0] as { numero: number } | undefined;
    if (!actuelle || actuelle.numero !== v.numero) throw new ErreurApi("regle_metier", "Une modification plus récente existe.");
    if (v.numero < 2) throw new ErreurApi("regle_metier", "Aucune version précédente.");
    const r = await revenirDans(client, v.instance_id, v.numero - 1, auteur, `annulation de la version ${v.numero}`);
    return { entite: "configurations", entite_id: r.id };
  },
};
