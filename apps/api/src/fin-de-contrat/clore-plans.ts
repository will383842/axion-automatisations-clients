import { exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import type { AlerteFin, EtapeFin } from "./machine.js";

// Clôture des plans récurrents du client dans le Hub (A-250), par la porte signée et la boîte d'envoi (T2-15) : plus aucune facture d'abonnement ne part.
// Un plan est clos quand la RÉPONSE du Hub est reçue. Un plan déposé mais jamais lié (réponse de création perdue) peut encore facturer : il bloque l'étape et alerte.
// Un brouillon non émis signalé par le Hub reste en alerte (hub/reponses.ts) ; rien n'est supprimé ici, les factures restent.
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
    dejaFait: async (t) => (await d.plans(t)).every((p) => p.idPlan !== null && p.reponseRecue),
    async faire(t, dossier) {
      await exigerAucunGel(d.gel, t, "preavis");
      for (const p of await d.plans(t)) {
        if (p.idPlan === null) await d.alerter({ type: "clore_plans", clientId: t, code: "plan_non_lie" });
        else if (!p.reponseRecue) await d.deposerClore(t, p.idPlan, dossier.dateFin);
      }
    },
  };
}
