import type { EmetteurC3 } from "./emetteur-c3.ts";

// Tâche de nuit (C-346) : à 30 jours d'un renouvellement (fin d'un abonnement du client), un seul fait renouvellement.proche par date.
// À appeler dans la transaction d'avecClient (tenant fixé).
export type Requeteur = { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };
export const JOURS_AVANT_RENOUVELLEMENT = 30;

const JOUR_MS = 86_400_000;
const enJour = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Sens de « s'arrête » en V1 (ADR 0059) : aucune colonne ne marque une résiliation ; seul le plan commercial dit « arrêt » (suite_maintenance), au niveau de l'organisation.
// Un abonnement est exclu quand son organisation a au moins un plan « arrêt » et aucun plan « reconduction » (organisation mixte : signalé, faute de lien abonnement ↔ plan).
// Le jour courant et les bornes sont calculés par la base, fuseau Europe/Paris (le serveur d'application est en UTC) ; « fin au jour J » est exclue, « J + 30 » incluse.
const SQL_RENOUVELLEMENTS = `SELECT DISTINCT to_char(a.fin, 'YYYY-MM-DD') AS date_renouvellement FROM abonnements a
  WHERE a.tenant_id = $1 AND a.fin > (now() AT TIME ZONE 'Europe/Paris')::date AND a.fin <= (now() AT TIME ZONE 'Europe/Paris')::date + $2::int
  AND NOT (
    EXISTS (SELECT 1 FROM instances i JOIN plans_commerciaux p ON p.tenant_id = i.tenant_id AND p.id = i.plan_commercial
            WHERE i.tenant_id = a.tenant_id AND i.organisation_id = a.organisation_id AND p.suite_maintenance = 'arret')
    AND NOT EXISTS (SELECT 1 FROM instances i JOIN plans_commerciaux p ON p.tenant_id = i.tenant_id AND p.id = i.plan_commercial
            WHERE i.tenant_id = a.tenant_id AND i.organisation_id = a.organisation_id AND p.suite_maintenance = 'reconduction'))
  ORDER BY 1`;

// Plage et non égalité : une nuit sans exécution ne fait perdre aucun renouvellement (le fait part à la nuit suivante, même clé par date).
// occurredAt vient de la date de fin (fin − 30 jours), jamais du jour d'exécution : le corps du fait ne change pas d'une nuit à l'autre.
export async function signalerRenouvellementsProches(client: Requeteur, emetteur: Pick<EmetteurC3, "renouvellementProche">, tenantId: string): Promise<number> {
  const lus = await client.query(SQL_RENOUVELLEMENTS, [tenantId, JOURS_AVANT_RENOUVELLEMENT]);
  // Plusieurs abonnements à la même date : un seul fait (la clé d'intention est la date).
  const dates = [...new Set(lus.rows.map((r) => r["date_renouvellement"] as string))];
  for (const date of dates) {
    const occurredAt = `${enJour(Date.parse(`${date}T00:00:00Z`) - JOURS_AVANT_RENOUVELLEMENT * JOUR_MS)}T00:00:00Z`;
    await emetteur.renouvellementProche({ id: `renouvellement:${date}`, occurredAt }, date);
  }
  return dates.length;
}
