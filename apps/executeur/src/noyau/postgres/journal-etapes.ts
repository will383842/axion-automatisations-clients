import type { Pool } from "pg";
import { avecClient } from "../../db/connexion.ts";
import { CLES_JOURNAL, type EntreeJournal, type JournalEtapes } from "../ports.ts";

// Journal des étapes (A-286) sur la table journal_etape, pour un seul client (tenant_id posé par avecClient, RLS forcée).
// Aucune migration (ADR 0102) : le statut « a_trancher » et l'essai tiennent dans la clé « <statut>-<essai> » ; la table n'a ni texte libre ni contenu.
const STATUT_BASE = { faite: "reussie", echec: "en_erreur", a_trancher: "en_erreur" } as const;
const CLE = /^(faite|echec|a_trancher)-(\d{1,3})$/;

export class JournalPostgres implements JournalEtapes {
  constructor(
    private pool: Pool,
    private tenantId: string,
  ) {}

  async inscrire(e: EntreeJournal): Promise<void> {
    const inconnue = Object.keys(e).find((k) => !(CLES_JOURNAL as readonly string[]).includes(k));
    if (inconnue) throw new Error(`clé interdite dans le journal : ${inconnue}`);
    const cle = `${e.statut}-${e.essai}`;
    await avecClient(this.pool, this.tenantId, async (c) => {
      const exec = await c.query<{ debut: Date }>("SELECT debut FROM executions WHERE tenant_id = $1 AND id = $2 AND instance_id = $3", [this.tenantId, e.executionId, e.instanceId]);
      if (!exec.rows[0]) throw new Error("execution_inconnue");
      // `debut` reste dans la base (SELECT) : un aller-retour par un Date JavaScript perd les microsecondes et casse la clé étrangère.
      // La base n'accepte une étape qu'en cours : elle passe à son statut final dans la même transaction.
      await c.query(
        "INSERT INTO journal_etape (tenant_id, id, execution_id, debut_execution, etape, cle) SELECT x.tenant_id, gen_random_uuid(), x.id, x.debut, $4, $5 FROM executions x WHERE x.tenant_id = $1 AND x.id = $2 AND x.instance_id = $3 ON CONFLICT (tenant_id, execution_id, etape, cle) DO NOTHING",
        [this.tenantId, e.executionId, e.instanceId, e.etape, cle],
      );
      await c.query("UPDATE journal_etape SET statut = $5 WHERE tenant_id = $1 AND execution_id = $2 AND etape = $3 AND cle = $4", [this.tenantId, e.executionId, e.etape, cle, STATUT_BASE[e.statut]]);
    });
  }

  async lire(instanceId: string, executionId: string): Promise<readonly EntreeJournal[]> {
    const { rows } = await avecClient(this.pool, this.tenantId, (c) =>
      c.query<{ etape: string; cle: string; cree_le: Date }>(
        "SELECT j.etape, j.cle, j.statut, j.cree_le FROM journal_etape j JOIN executions e ON e.tenant_id = j.tenant_id AND e.id = j.execution_id AND e.debut = j.debut_execution WHERE j.tenant_id = $1 AND j.execution_id = $2 AND e.instance_id = $3 AND j.statut <> 'en_cours' ORDER BY j.cree_le, j.cle",
        [this.tenantId, executionId, instanceId],
      ),
    );
    return rows.flatMap((r) => {
      const m = CLE.exec(r.cle);
      return m ? [{ instanceId, executionId, etape: r.etape, statut: m[1] as EntreeJournal["statut"], essai: Number(m[2]), a: new Date(r.cree_le).toISOString() }] : [];
    });
  }
}
