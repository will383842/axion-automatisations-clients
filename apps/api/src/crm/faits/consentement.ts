import type { Issue } from "./entreprise.js";
import type { FaitDe, TxC3 } from "./types.js";

type Personne = FaitDe<"consentement.retire" | "effacement.demande">;

// L'empreinte reçue est ajoutée aux exclusions dans la même transaction que le fait. Rien n'est supprimé (l'effacement attend Will).
// Le contrat C1 n'a pas de route d'exclusion en version 0 : l'exclusion est signalée « à reporter dans le Hub ».
export async function retraitDePersonne(tx: TxC3, e: Personne): Promise<Issue> {
  const empreinte = e.payload.emailEmpreinte;
  await tx.exclure(empreinte, e.event_type === "effacement.demande" ? "demande_client" : "desabonnement");
  const alertes: Issue["alertes"] = [{ type: "exclusion_a_reporter_dans_le_hub", reference: empreinte }];
  if (e.event_type === "effacement.demande") alertes.push({ type: "effacement_demande", reference: empreinte });
  return { resultat: "traite", alertes };
}
