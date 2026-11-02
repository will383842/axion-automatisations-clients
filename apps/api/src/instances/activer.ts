// Activation d'une instance (T2-05, ADR 0053). Le service donne un message clair à l'écran ; la base reste la garantie
// (déclencheur instances_sous_traitance, migration 0009) : même règle, même motif, y compris si le contrat disparaît ou est révoqué entre la lecture et l'écriture.
// À appeler dans la transaction d'avecClient (tenant fixé) : jamais avec un pool direct.
import type { EmetteurC3 } from "../crm/emetteur-c3.ts";
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

export async function activerInstance(client: Requeteur, tenantId: string, instanceId: string, emetteur?: Pick<EmetteurC3, "automatisationActivee">): Promise<void> {
  const instance = await client.query("SELECT organisation_id, code_automatisation FROM instances WHERE tenant_id = $1 AND id = $2", [tenantId, instanceId]);
  const organisation = instance.rows[0]?.["organisation_id"];
  if (!organisation) throw new ErreurRegleMetier("instance_introuvable");
  const contrat = await client.query(
    "SELECT 1 AS un FROM contrats WHERE tenant_id = $1 AND organisation_id = $2 AND type = 'sous_traitance_art28' AND date_signature <= current_date AND revoque_le IS NULL LIMIT 1",
    [tenantId, organisation],
  );
  if (contrat.rows.length === 0) throw new ErreurRegleMetier(MOTIF_SOUS_TRAITANCE_ABSENTE);
  try {
    // Seul un vrai changement d'état écrit et émet : une instance déjà active ne change rien. Le jour vient de la base (Europe/Paris), pas de l'horloge de l'application (UTC).
    const maj = await client.query(
      "UPDATE instances SET etat = 'active' WHERE tenant_id = $1 AND id = $2 AND etat <> 'active' RETURNING to_char((now() AT TIME ZONE 'Europe/Paris')::date, 'YYYY-MM-DD') AS jour",
      [tenantId, instanceId],
    );
    if (maj.rowCount === 0) {
      // Aucune ligne modifiée : soit déjà active (rien à faire, aucun fait), soit disparue entre la lecture et l'écriture (jamais un succès silencieux).
      const encore = await client.query("SELECT organisation_id, code_automatisation FROM instances WHERE tenant_id = $1 AND id = $2", [tenantId, instanceId]);
      if (!encore.rows[0]?.["organisation_id"]) throw new ErreurRegleMetier("instance_introuvable");
      return;
    }
    // Fait C3 déposé dans la même transaction : une activation annulée n'envoie rien (T2-18). Le jour est dans la clé : un autre jour, un autre fait.
    if (emetteur) {
      const jour = maj.rows[0]?.["jour"] as string;
      await emetteur.automatisationActivee({ id: `activation:${instanceId}:${jour}`, occurredAt: `${jour}T00:00:00Z` }, instance.rows[0]?.["code_automatisation"] as string, jour);
    }
  } catch (e) {
    if ((e as { code?: string }).code === "P0001" && (e as { detail?: string }).detail === MOTIF_SOUS_TRAITANCE_ABSENTE) throw new ErreurRegleMetier(MOTIF_SOUS_TRAITANCE_ABSENTE);
    throw e;
  }
}
