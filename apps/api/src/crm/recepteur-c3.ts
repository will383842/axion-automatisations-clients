import { EvenementCrm } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { retraitDePersonne } from "./faits/consentement.js";
import { apporteurRattache, devenueCliente, ficheFusionnee, miseAJour, type Issue } from "./faits/entreprise.js";
import type { AlertesC3, DepotC3, FaitCrm, ResultatFait } from "./faits/types.js";

export interface DepsRecepteurC3 {
  depot: DepotC3;
  alertes: AlertesC3;
}
export type ResultatTraitement = { doublon: true } | { doublon: false; resultat: ResultatFait };

// Rejoue les alertes rangées mais non confirmées : une panne d'envoi n'en perd aucune (au moins une fois).
async function envoyerAlertes(deps: DepsRecepteurC3, eventId: string): Promise<void> {
  const enAttente = await deps.depot.transaction((tx) => tx.alertesNonConfirmees(eventId));
  for (const { id, alerte } of enAttente) {
    await deps.alertes.signaler(alerte);
    await deps.depot.transaction((tx) => tx.confirmerAlerte(id));
  }
}

// Traite un fait du CRM (appelé par la tâche BullMQ, jobId = event_id). Le fait, son effet, ses alertes et son résultat sont écrits dans une seule transaction.
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
        await tx.rangerAlertes(e.event_id, i.alertes);
        await tx.marquerTraite(e.event_id, i.resultat);
        return i;
      });
      // Les alertes partent après la validation (une alerte ne précède jamais un fait annulé) ; un doublon rejoue celles non confirmées.
      await envoyerAlertes(deps, e.event_id);
      if (!issue) return { doublon: true };
      return { doublon: false, resultat: issue.resultat };
    },
  };
}
