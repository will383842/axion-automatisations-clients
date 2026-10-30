import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";

// Client actif (C5, lot 2) : comment une requête de l'application ne voit que son client.
// 1. Toute lecture ou écriture d'une table métier passe par avecClient(pool, tenantId, fn), jamais par pool.query.
// 2. avecClient ouvre une transaction et fixe app.tenant_id avec set_config(..., true) : la valeur vaut jusqu'à la fin
//    de la transaction, donc elle ne reste pas sur la connexion rendue à PgBouncer (mode transaction).
// 3. Jamais de SET de session : derrière PgBouncer, la connexion serveur change d'une transaction à l'autre.
// 4. fn reçoit le client de la transaction ; elle ne doit ni valider ni annuler elle-même.
// 5. Les politiques RLS du modèle (ops/socle/postgres/modele-politique-rls.sql) comparent tenant_id à cette valeur.
// 6. Les lectures de toutes les données passent par avecEquipe(poolEquipe, fn) : autre rôle, autre pool, lecture seule.
// 7. avecClient peut aussi fixer l'acteur et l'adresse de l'appelant (app.acteur, app.ip), de la même façon : portée de la transaction.
//    Le journal d'audit les lit ; ils ne passent jamais d'une transaction à la suivante. L'adresse est validée (net.isIP), l'acteur borné.
// 8. Dès le BEGIN, toute transaction (avecClient comme avecEquipe) pose idle_in_transaction_session_timeout et lock_timeout à 5 s : une transaction
//    qui tient une ligne sans rien faire ne bloque pas, par le journal d'audit, les écritures des autres clients (ADR 0042, réserve R1 ; ADR 0044).
// Limite : un SQL arbitraire exécuté par l'application peut fixer app.tenant_id lui-même ; seul ce fichier doit le faire.

// Portée de la transaction (true), jamais de la session ; pas d'ALTER ROLE (garde des migrations, ADR 0041).
const DELAIS = "SELECT set_config('idle_in_transaction_session_timeout', '5s', true), set_config('lock_timeout', '5s', true)";
const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export type Appelant = { acteur: string; ip?: string };
const ACTEUR_MAX = 128;
// Pas de caractère de contrôle (saut de ligne, nul), invisible ou d'inversion dans l'acteur : il finit dans le journal d'audit. Même classe que audit_ajouter (migration 0002).
const CONTROLE = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F\uFEFF\u061C\u180E\u00AD\u3164]/u;

export function verifierAppelant(appelant: Appelant): void {
  const acteur = appelant.acteur;
  if (typeof acteur !== "string" || acteur.trim() === "" || acteur.length > ACTEUR_MAX || CONTROLE.test(acteur)) throw new Error("acteur invalide (1 à 128 caractères, sans caractère de contrôle)");
  // Une adresse avec zone (« fe80::1%eth0 ») est une IP pour Node mais pas pour le type inet de PostgreSQL : refusée.
  if (appelant.ip !== undefined && (isIP(appelant.ip) === 0 || appelant.ip.includes("%"))) throw new Error("adresse IP invalide");
}

export async function avecClient<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>, appelant?: Appelant): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("identifiant de client invalide");
  if (appelant) verifierAppelant(appelant);
  return enTransaction(
    pool,
    async (client) => {
      await client.query("BEGIN");
      await client.query(DELAIS);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      if (appelant) await client.query("SELECT set_config('app.acteur', $1, true), set_config('app.ip', $2, true)", [appelant.acteur, appelant.ip ?? ""]);
    },
    fn,
  );
}

export async function avecEquipe<T>(poolEquipe: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return enTransaction(
    poolEquipe,
    async (client) => {
      await client.query("BEGIN READ ONLY");
      await client.query(DELAIS);
    },
    fn,
  );
}
