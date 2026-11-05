// Client minimal : un `pg.PoolClient` y répond. Le paquet n'ouvre aucune connexion et ne dépend d'aucun pilote.
export interface ClientLecture { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

const DELAI_MAX_MS = 600_000;

// Lecture seule, sous délai : BEGIN READ ONLY, SET LOCAL statement_timeout, la requête, COMMIT (ROLLBACK si elle échoue). Le délai ne reste pas sur la connexion.
// SET ne prend pas de paramètre lié : le délai est un entier borné, vérifié avant tout envoi.
export async function executerLecture(client: ClientLecture, sql: { texte: string; valeurs: unknown[] }, options: { delaiMs: number }): Promise<Record<string, unknown>[]> {
  const delai = options.delaiMs;
  if (typeof delai !== "number" || !Number.isInteger(delai) || delai < 1 || delai > DELAI_MAX_MS) throw new Error("délai illisible");
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(`SET LOCAL statement_timeout = ${delai}`);
    const { rows } = await client.query(sql.texte, sql.valeurs);
    await client.query("COMMIT");
    return rows;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}
