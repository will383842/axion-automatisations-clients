// Client minimal : un `pg.PoolClient` y répond. Le paquet n'ouvre aucune connexion et ne dépend d'aucun pilote.
export interface ClientLecture { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

const DELAI_MAX_MS = 600_000;

// Erreur à traiter par `release(err)` : la connexion n'est plus sûre. Le message ne contient aucun SQL ; l'erreur d'origine est dans `cause`.
export class ErreurConnexionPerdue extends Error {
  readonly connexionPerdue = true as const;
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = "ErreurConnexionPerdue"; }
}

// Lecture seule, sous délai : BEGIN READ ONLY, SET LOCAL statement_timeout, contrôle de la lecture seule, la requête, COMMIT (ROLLBACK si elle échoue).
// Si le ROLLBACK échoue ou si la transaction n'est pas en lecture seule, l'erreur porte `connexionPerdue: true` : l'appelant fait `release(err)`. Le délai ne reste pas sur la connexion.
// SET ne prend pas de paramètre lié : le délai est un entier borné, vérifié avant tout envoi.
export async function executerLecture(client: ClientLecture, sql: { texte: string; valeurs: unknown[] }, options: { delaiMs: number }): Promise<Record<string, unknown>[]> {
  const delai = options.delaiMs;
  if (typeof delai !== "number" || !Number.isInteger(delai) || delai < 1 || delai > DELAI_MAX_MS) throw new Error("délai illisible");
  // Protocole simple de node-pg : sans valeur liée, plusieurs instructions passeraient. Toute requête générée en porte au moins une.
  if (!Array.isArray(sql.valeurs) || sql.valeurs.length === 0) throw new Error("valeurs absentes ou vides");
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(`SET LOCAL statement_timeout = ${delai}`);
    const ro = (await client.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0]?.ro;
    if (ro !== "on") throw new ErreurConnexionPerdue("transaction non protégée en lecture seule");
    const { rows } = await client.query(sql.texte, sql.valeurs);
    await client.query("COMMIT");
    return rows;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { throw new ErreurConnexionPerdue("annulation impossible, connexion à écarter", e); }
    throw e;
  }
}
