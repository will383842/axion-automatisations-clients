import type { EmetteurC3 } from "./emetteur-c3.ts";

// Tâche de nuit (C-346) : à 30 jours d'un renouvellement (fin d'un abonnement du client), un seul fait renouvellement.proche par date.
// À appeler dans la transaction d'avecClient (tenant fixé).
export type Requeteur = { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };
export const JOURS_AVANT_RENOUVELLEMENT = 30;

const JOUR_MS = 86_400_000;
const enJour = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Un abonnement qui s'arrête ne se renouvelle pas : exclu quand les plans de l'organisation disent tous « arrêt » (suite_maintenance).
// Le lien direct abonnement ↔ plan n'existe pas encore (dette, ADR 0059).
const SQL_RENOUVELLEMENTS = `SELECT DISTINCT to_char(a.fin, 'YYYY-MM-DD') AS date_renouvellement FROM abonnements a
  WHERE a.tenant_id = $1 AND a.fin > $2::date AND a.fin <= $3::date
  AND NOT (
    EXISTS (SELECT 1 FROM instances i JOIN plans_commerciaux p ON p.tenant_id = i.tenant_id AND p.id = i.plan_commercial
            WHERE i.tenant_id = a.tenant_id AND i.organisation_id = a.organisation_id AND p.suite_maintenance = 'arret')
    AND NOT EXISTS (SELECT 1 FROM instances i JOIN plans_commerciaux p ON p.tenant_id = i.tenant_id AND p.id = i.plan_commercial
            WHERE i.tenant_id = a.tenant_id AND i.organisation_id = a.organisation_id AND p.suite_maintenance = 'reconduction'))
  ORDER BY 1`;

// Plage et non égalité : une nuit sans exécution ne fait perdre aucun renouvellement (le fait part à la nuit suivante, même clé par date).
// occurredAt vient de la date de fin (fin − 30 jours), jamais du jour d'exécution : le corps du fait ne change pas d'une nuit à l'autre.
export async function signalerRenouvellementsProches(client: Requeteur, emetteur: Pick<EmetteurC3, "renouvellementProche">, tenantId: string, aujourdhui: string): Promise<number> {
  const cible = enJour(Date.parse(`${aujourdhui}T00:00:00Z`) + JOURS_AVANT_RENOUVELLEMENT * JOUR_MS);
  const lus = await client.query(SQL_RENOUVELLEMENTS, [tenantId, aujourdhui, cible]);
  // Plusieurs abonnements à la même date : un seul fait (la clé d'intention est la date).
  const dates = [...new Set(lus.rows.map((r) => r["date_renouvellement"] as string))];
  for (const date of dates) {
    const occurredAt = `${enJour(Date.parse(`${date}T00:00:00Z`) - JOURS_AVANT_RENOUVELLEMENT * JOUR_MS)}T00:00:00Z`;
    await emetteur.renouvellementProche({ id: `renouvellement:${date}`, occurredAt }, tenantId, date);
  }
  return dates.length;
}
