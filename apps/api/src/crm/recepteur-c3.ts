import { EvenementCrm } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { retraitDePersonne } from "./faits/consentement.js";
import { apporteurRattache, devenueCliente, ficheFusionnee, miseAJour, type Issue } from "./faits/entreprise.js";
import type { AlertesC3, DepotC3, FaitCrm, ResultatFait } from "./faits/types.js";

export interface DepsRecepteurC3 {
  depot: DepotC3;
  alertes: AlertesC3;
}
export type ResultatTraitement = { doublon: true } | { doublon: false; resultat: ResultatFait };

// Traite un fait du CRM (appelé par la tâche BullMQ, jobId = event_id). Le fait, son effet et son résultat sont écrits dans une seule transaction.
export function creerRecepteurC3(deps: DepsRecepteurC3) {
  return {
    async traiter(brut: unknown): Promise<ResultatTraitement> {
      const e = EvenementCrm.parse(brut) as unknown as FaitCrm;
      const issue = await deps.depot.transaction(async (tx): Promise<Issue | null> => {
        if (!(await tx.rangerFait({ eventId: e.event_id, type: e.event_type, sequence: e.sequence, sujet: e.subject_ref.crmCompanyId }))) return null;
        let i: Issue;
        switch (e.event_type) {
          case "entreprise.devenue_cliente": i = await devenueCliente(tx, e); break;
          case "entreprise.mise_a_jour": i = await miseAJour(tx, e); break;
          case "apporteur.rattache": i = await apporteurRattache(tx, e); break;
          case "fiche.fusionnee": i = await ficheFusionnee(tx, e); break;
          case "consentement.retire":
          case "effacement.demande": i = await retraitDePersonne(tx, e); break;
        }
        await tx.marquerTraite(e.event_id, i.resultat);
        return i;
      });
      if (!issue) return { doublon: true };
      // Les alertes partent après la validation : une alerte ne précède jamais un fait annulé.
      for (const a of issue.alertes) await deps.alertes.signaler(a);
      return { doublon: false, resultat: issue.resultat };
    },
  };
}
