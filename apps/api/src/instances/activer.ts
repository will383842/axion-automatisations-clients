// Activation d'une instance (T2-05, ADR 0053). Le service donne un message clair à l'écran ; la base reste la garantie
// (déclencheur instances_sous_traitance, migration 0009) : même règle, même motif, y compris si le contrat disparaît ou est révoqué entre la lecture et l'écriture.
// À appeler dans la transaction d'avecClient (tenant fixé) : jamais avec un pool direct.
export const MOTIF_SOUS_TRAITANCE_ABSENTE = "sous_traitance_absente";

export type Requeteur = { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

const MESSAGES: Record<string, string> = {
  [MOTIF_SOUS_TRAITANCE_ABSENTE]: "Le contrat de sous-traitance du client n'est pas signé : l'instance ne peut pas être activée.",
  instance_introuvable: "Cette instance n'existe pas pour ce client.",
};

export class ErreurRegleMetier extends Error {
  readonly code = "regle_metier";
  constructor(readonly motif: keyof typeof MESSAGES | string) {
    super(MESSAGES[motif] ?? motif);
  }
}

export async function activerInstance(client: Requeteur, tenantId: string, instanceId: string): Promise<void> {
  const instance = await client.query("SELECT organisation_id FROM instances WHERE tenant_id = $1 AND id = $2", [tenantId, instanceId]);
  const organisation = instance.rows[0]?.["organisation_id"];
  if (!organisation) throw new ErreurRegleMetier("instance_introuvable");
  const contrat = await client.query(
    "SELECT 1 AS un FROM contrats WHERE tenant_id = $1 AND organisation_id = $2 AND type = 'sous_traitance_art28' AND date_signature <= current_date AND revoque_le IS NULL LIMIT 1",
    [tenantId, organisation],
  );
  if (contrat.rows.length === 0) throw new ErreurRegleMetier(MOTIF_SOUS_TRAITANCE_ABSENTE);
  try {
    const maj = await client.query("UPDATE instances SET etat = 'active' WHERE tenant_id = $1 AND id = $2", [tenantId, instanceId]);
    // Aucune ligne modifiée : l'instance a disparu (ou n'est plus visible) entre la lecture et l'écriture ; jamais un succès silencieux.
    if (maj.rowCount === 0) throw new ErreurRegleMetier("instance_introuvable");
  } catch (e) {
    if ((e as { code?: string }).code === "P0001" && (e as { detail?: string }).detail === MOTIF_SOUS_TRAITANCE_ABSENTE) throw new ErreurRegleMetier(MOTIF_SOUS_TRAITANCE_ABSENTE);
    throw e;
  }
}
