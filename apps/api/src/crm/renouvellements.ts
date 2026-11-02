import type { EmetteurC3 } from "./emetteur-c3.ts";

// Tâche de nuit (C-346) : à 30 jours d'un renouvellement (fin d'un abonnement du client), un seul fait renouvellement.proche par date.
// À appeler dans la transaction d'avecClient (tenant fixé).
export type Requeteur = { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };
export const JOURS_AVANT_RENOUVELLEMENT = 30;

export async function signalerRenouvellementsProches(client: Requeteur, emetteur: Pick<EmetteurC3, "renouvellementProche">, tenantId: string, aujourdhui: string): Promise<number> {
  const cible = new Date(Date.parse(`${aujourdhui}T00:00:00Z`) + JOURS_AVANT_RENOUVELLEMENT * 86_400_000).toISOString().slice(0, 10);
  const lus = await client.query("SELECT to_char(fin, 'YYYY-MM-DD') AS date_renouvellement FROM abonnements WHERE tenant_id = $1 AND fin = $2::date", [tenantId, cible]);
  // Plusieurs abonnements à la même date : un seul fait (la clé d'intention est la date).
  const dates = [...new Set(lus.rows.map((r) => r["date_renouvellement"] as string))];
  for (const date of dates) await emetteur.renouvellementProche({ id: `renouvellement:${date}`, occurredAt: `${aujourdhui}T00:00:00Z` }, tenantId, date);
  return dates.length;
}
