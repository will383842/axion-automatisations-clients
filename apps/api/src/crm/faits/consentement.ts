import type { Issue } from "./entreprise.js";
import type { FaitDe, TxC3 } from "./types.js";

type Personne = FaitDe<"consentement.retire" | "effacement.demande">;

// Règle de Will : une opposition met à l'écart des envois, durablement ; les données sont gardées, aucun contact n'est supprimé.
// L'exclusion est rangée par empreinte, sans lire les contacts : un fait reçu avant l'import garde son effet (ADR 0106).
// Portée : consentement.retire = désabonnement, propre au client du sujet ; effacement.demande = « opposition », globale à la plateforme.
// Le contrat C1 n'a pas de route d'exclusion en version 0 : l'exclusion est signalée « à reporter dans le Hub ».
export async function retraitDePersonne(tx: TxC3, e: Personne): Promise<Issue> {
  const empreinte = e.payload.emailEmpreinte;
  await tx.exclure({ empreinte, genre: e.event_type === "effacement.demande" ? "opposition" : "desabonnement", crmCompanyId: e.subject_ref.crmCompanyId });
  const alertes: Issue["alertes"] = [{ type: "exclusion_a_reporter_dans_le_hub", reference: empreinte }];
  if (e.event_type === "effacement.demande") alertes.push({ type: "effacement_demande", reference: empreinte });
  return { resultat: "traite", alertes };
}
