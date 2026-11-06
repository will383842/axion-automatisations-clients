import type { PoolClient } from "pg";

// Crochet après le rangement d'une exécution terminée (T4-23) : agrégat du jour et santé de l'instance, dans la MÊME transaction que le rangement.
// Le client reçu est celui d'avecClient (tenant et acteur déjà fixés, RLS appliquée). Le dédoublonnage reste celui de T4-23 : n'appeler ce crochet
// que lorsque le rangement a réellement passé la ligne à « reussie » ou « echec » (un paquet rejoué ne le rappelle pas).
export interface ExecutionRangee {
  tenantId: string;
  instanceId: string;
  statut: "reussie" | "echec";
  dureeMs: number;
  coutMicroCentimes: number;
  finLe: Date;
  prochaineAttendueLe: Date | null;
}

export const SQL_AGREGAT =
  "INSERT INTO agregats_quotidiens (tenant_id, id, instance_id, jour, nombre, echecs, duree_totale_ms, cout_micro_centimes, auteur) " +
  "VALUES ($1, gen_random_uuid(), $2, $3, 1, $4, $5, $6, $7) " +
  "ON CONFLICT (tenant_id, instance_id, jour) DO UPDATE SET nombre = agregats_quotidiens.nombre + 1, echecs = agregats_quotidiens.echecs + EXCLUDED.echecs, " +
  "duree_totale_ms = agregats_quotidiens.duree_totale_ms + EXCLUDED.duree_totale_ms, cout_micro_centimes = agregats_quotidiens.cout_micro_centimes + EXCLUDED.cout_micro_centimes, auteur = EXCLUDED.auteur";

// $3 = dernière réussite (null après un échec : la valeur précédente est gardée), $4 = prochaine attendue (null : gardée).
export const SQL_SANTE =
  "INSERT INTO sante_instances (tenant_id, id, instance_id, derniere_reussite_le, prochaine_attendue_le) VALUES ($1, gen_random_uuid(), $2, $3, $4) " +
  "ON CONFLICT (tenant_id, instance_id) DO UPDATE SET derniere_reussite_le = COALESCE(EXCLUDED.derniere_reussite_le, sante_instances.derniere_reussite_le), " +
  "prochaine_attendue_le = COALESCE(EXCLUDED.prochaine_attendue_le, sante_instances.prochaine_attendue_le)";

export async function appliquerExecution(client: Pick<PoolClient, "query">, e: ExecutionRangee, acteur: string): Promise<void> {
  const echec = e.statut === "echec" ? 1 : 0;
  await client.query(SQL_AGREGAT, [e.tenantId, e.instanceId, e.finLe.toISOString().slice(0, 10), echec, e.dureeMs, e.coutMicroCentimes, acteur]);
  await client.query(SQL_SANTE, [e.tenantId, e.instanceId, e.statut === "reussie" ? e.finLe : null, e.statut === "reussie" ? e.prochaineAttendueLe : null]);
}
