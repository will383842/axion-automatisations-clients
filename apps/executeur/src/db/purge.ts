import type { Pool } from "pg";

// Purge de l'état technique de la base moteur (A-183, A-185, A-314, C-021) : rôle moteur_purge, qui n'a de droit que sur moteur.
// Réussites après 24 h, erreurs après 7 jours. Jamais une instance sous gel pour litige (C-609). Jamais sans réponse du gel.
// Aucune donnée de client dans cette base (C-022) : rien dans console, rien dans cli_<id>. Ni DROP ni TRUNCATE : seulement des DELETE sous RLS.
export const DELAI_REUSSITE_MS = 24 * 3_600_000;
export const DELAI_ERREUR_MS = 7 * 24 * 3_600_000;

// Instances sous gel (lues dans le registre de la console par l'appelant). Une erreur ou l'absence de lecture arrête la purge.
export type LireGel = () => Promise<ReadonlySet<string>>;
export type ResultatPurge = { purgees: number; arret?: "gel_illisible" };

export function estPurgeable(e: { issue: "reussite" | "erreur" | null; fin: Date | null; instanceId: string }, maintenant: Date, gel: ReadonlySet<string>): boolean {
  if (e.fin === null || e.issue === null || gel.has(e.instanceId)) return false;
  const delai = e.issue === "reussite" ? DELAI_REUSSITE_MS : DELAI_ERREUR_MS;
  return maintenant.getTime() - e.fin.getTime() > delai;
}

// Même règle que estPurgeable, en SQL : une exécution part avec ses étapes et ses intentions « faites » ;
// elle reste tant qu'une intention n'est pas terminée (la clé d'intention est l'anti-doublon de dernier recours).
const CIBLES = `
  SELECT e.tenant_id, e.id, e.debut FROM executions e
  WHERE e.fin IS NOT NULL AND NOT (e.instance_id = ANY($3::uuid[]))
    AND ((e.issue = 'reussite' AND e.fin < $1) OR (e.issue = 'erreur' AND e.fin < $2))
    AND NOT EXISTS (SELECT 1 FROM intentions i WHERE i.tenant_id = e.tenant_id AND i.execution_id = e.id AND i.debut_execution = e.debut AND i.etat <> 'faite')`;

export async function purger(pool: Pool, options: { lireGel?: LireGel; maintenant?: Date } = {}): Promise<ResultatPurge> {
  let gel: ReadonlySet<string>;
  try {
    if (!options.lireGel) throw new Error("lecture du gel absente");
    gel = await options.lireGel();
  } catch {
    return { purgees: 0, arret: "gel_illisible" };
  }
  const maintenant = options.maintenant ?? new Date();
  const parametres = [new Date(maintenant.getTime() - DELAI_REUSSITE_MS), new Date(maintenant.getTime() - DELAI_ERREUR_MS), [...gel]];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Une seule instruction : les mêmes cibles pour les trois suppressions (CTE modifiantes), sans table temporaire (refusée à ce rôle).
    const r = await client.query(
      `WITH cibles AS (${CIBLES}),
       etapes AS (DELETE FROM journal_etape j USING cibles c WHERE j.tenant_id = c.tenant_id AND j.execution_id = c.id AND j.debut_execution = c.debut RETURNING 1),
       faites AS (DELETE FROM intentions i USING cibles c WHERE i.etat = 'faite' AND i.tenant_id = c.tenant_id AND i.execution_id = c.id AND i.debut_execution = c.debut RETURNING 1)
       DELETE FROM executions e USING cibles c WHERE e.tenant_id = c.tenant_id AND e.id = c.id AND e.debut = c.debut`,
      parametres,
    );
    await client.query("COMMIT");
    return { purgees: r.rowCount ?? 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
