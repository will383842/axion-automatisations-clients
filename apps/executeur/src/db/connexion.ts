import type { Pool, PoolClient } from "pg";

// Client actif de la base moteur (ADR 0035) : même règle que l'API. Toute lecture ou écriture d'une table de moteur passe par avecClient.
// 1. BEGIN, puis set_config('app.tenant_id', …, true) : la valeur s'arrête à la fin de la transaction, jamais de réglage de session (PgBouncer, mode transaction).
// 2. Sans ce réglage, la RLS ne montre aucune ligne : jamais toutes.
// 3. fn reçoit le client de la transaction ; elle ne valide ni n'annule elle-même.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELAIS = "SELECT set_config('idle_in_transaction_session_timeout', '5s', true), set_config('lock_timeout', '5s', true)";

export async function avecClient<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("identifiant de client invalide");
  const client = await pool.connect();
  let detruire = false;
  try {
    await client.query("BEGIN");
    await client.query(DELAIS);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const resultat = await fn(client);
    try {
      await client.query("COMMIT");
    } catch (erreur) {
      detruire = true;
      throw erreur;
    }
    return resultat;
  } catch (erreur) {
    await client.query("ROLLBACK").catch(() => (detruire = true));
    throw erreur;
  } finally {
    client.release(detruire);
  }
}

const TENANT = "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid";

// Les partitions créées par pg_partman ne reprennent pas la RLS de la table parente, et les invariants C5 contrôlent chaque partition comme une table.
// À appeler avec moteur_migration (propriétaire par SET ROLE) après chaque migration et après chaque entretien des partitions. Idempotent.
// moteur_app n'a aucun droit sur une partition : il passe par la table parente ; ces politiques ne sont qu'une seconde barrière.
export async function securiserPartitions(client: Pick<PoolClient, "query">): Promise<number> {
  const { rows } = await client.query<{ nom: string; securisee: boolean }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS nom, (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)) AS securisee
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.inhparent IN ('public.executions'::regclass)`,
  );
  let securisees = 0;
  for (const p of rows.filter((r) => !r.securisee)) {
    await client.query(`ALTER TABLE ${p.nom} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${p.nom} FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS isolation_client ON ${p.nom}`);
    await client.query(`CREATE POLICY isolation_client ON ${p.nom} FOR ALL TO moteur_app USING (${TENANT}) WITH CHECK (${TENANT})`);
    await client.query(`REVOKE ALL ON TABLE ${p.nom} FROM PUBLIC`);
    securisees++;
  }
  return securisees;
}
