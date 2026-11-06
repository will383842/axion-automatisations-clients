import type { GelLitige } from "../retention/purger.js";
import { echeance, type AlerteFin, type EtapeFin } from "./machine.js";

// Clôture des plans récurrents du client dans le Hub (A-250), par la porte signée et la boîte d'envoi (T2-15) : plus aucune facture d'abonnement ne part.
// Un plan est clos quand la RÉPONSE du Hub est reçue. Un plan déposé mais jamais lié (réponse de création perdue) peut encore facturer : il bloque l'étape et alerte.
// Un gel pour litige ne suspend PAS cette étape : clore un plan ne détruit rien, et la facturation d'abonnement doit s'arrêter à la date de fin (C-609 ne vise que les préavis et les retraits).
// Un brouillon non émis signalé par le Hub reste en alerte (hub/reponses.ts) ; rien n'est supprimé ici, les factures restent.
// reponseRecue : le Hub a répondu par un SUCCÈS à la clôture de ce plan (une erreur, un délai dépassé ou une absence de réponse restent false : le plan peut encore facturer).
export interface PlanHub { idPlan: string | null; reponseRecue: boolean }
export interface PortsClore {
  plans(tenantId: string): Promise<PlanHub[]>;
  // Dépôt dans la boîte d'envoi, intention stable `clore:<idPlan>` : redéposer ne crée rien de plus.
  deposerClore(tenantId: string, idPlan: string, dateFin: string): Promise<void>;
  alerter(a: AlerteFin): Promise<void>;
  gel: Pick<GelLitige, "gelActif">;
}
export function etapeClore(d: PortsClore): EtapeFin {
  return {
    nom: "clore_plans",
    sousGel: false,
    // Minuit Europe/Paris de la date de fin : ni avant (aucune clôture des mois à l'avance), ni en retard.
    echeance: (dossier) => echeance(dossier.dateFin, 0),
    dejaFait: async (t) => (await d.plans(t)).every((p) => p.idPlan !== null && p.reponseRecue),
    async faire(t, dossier) {
      // Le gel est seulement signalé à l'équipe : la clôture continue.
      if (await d.gel.gelActif(t)) await d.alerter({ type: "clore_plans", clientId: t, code: "cloture_sous_gel" });
      for (const p of await d.plans(t)) {
        if (p.idPlan === null) await d.alerter({ type: "clore_plans", clientId: t, code: "plan_non_lie" });
        else if (!p.reponseRecue) await d.deposerClore(t, p.idPlan, dossier.dateFin);
      }
    },
  };
}
