import type { Pool, PoolClient } from "pg";

// Client actif (C5, lot 2) : comment une requête de l'application ne voit que son client.
// 1. Toute lecture ou écriture d'une table métier passe par avecClient(pool, tenantId, fn), jamais par pool.query.
// 2. avecClient ouvre une transaction et fixe app.tenant_id avec set_config(..., true) : la valeur vaut jusqu'à la fin
//    de la transaction, donc elle ne reste pas sur la connexion rendue à PgBouncer (mode transaction).
// 3. Jamais de SET de session : derrière PgBouncer, la connexion serveur change d'une transaction à l'autre.
// 4. fn reçoit le client de la transaction ; elle ne doit ni valider ni annuler elle-même.
// 5. Les politiques RLS du modèle (ops/socle/postgres/modele-politique-rls.sql) comparent tenant_id à cette valeur.
// 6. Les lectures de toutes les données passent par avecEquipe(poolEquipe, fn) : autre rôle, autre pool, lecture seule.
// Limite : un SQL arbitraire exécuté par l'application peut fixer app.tenant_id lui-même ; seul ce fichier doit le faire.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function enTransaction<T>(pool: Pool, ouvrir: (client: PoolClient) => Promise<void>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let detruire = false;
  try {
    await ouvrir(client);
    const resultat = await fn(client);
    try {
      await client.query("COMMIT");
    } catch (erreur) {
      detruire = true;
      throw erreur;
    }
    return resultat;
  } catch (erreur) {
    // Une annulation qui échoue laisse la connexion dans un état inconnu : on la détruit au lieu de la rendre au pool.
    await client.query("ROLLBACK").catch(() => (detruire = true));
    throw erreur;
  } finally {
    if (detruire) client.release(true);
    else client.release();
  }
}

export async function avecClient<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("identifiant de client invalide");
  return enTransaction(
    pool,
    async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    },
    fn,
  );
}

export async function avecEquipe<T>(poolEquipe: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return enTransaction(poolEquipe, async (client) => void (await client.query("BEGIN READ ONLY")), fn);
}
