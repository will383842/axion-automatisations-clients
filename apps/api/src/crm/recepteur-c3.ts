import { EvenementCrm } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { retraitDePersonne } from "./faits/consentement.js";
import { apporteurRattache, devenueCliente, ficheFusionnee, miseAJour, type Issue } from "./faits/entreprise.js";
import type { AlerteC3, AlertesC3, DepotC3, FaitCrm, ResultatFait } from "./faits/types.js";

export interface DepsRecepteurC3 {
  depot: DepotC3;
  alertes: AlertesC3;
}
export type ResultatTraitement = { doublon: true } | { doublon: false; resultat: ResultatFait };

// Envoie les alertes rangées, une à une, et confirme chacune après un envoi réussi (au moins une fois).
// Un envoi qui lève ne fait PAS échouer la tâche (aucun essai BullMQ de plus, le fait est déjà traité) : l'alerte reste non confirmée
// et c'est le balayage qui la renvoie. Rend le nombre d'alertes confirmées.
async function envoyer(deps: DepsRecepteurC3, enAttente: { id: string; alerte: AlerteC3 }[]): Promise<number> {
  let confirmees = 0;
  for (const { id, alerte } of enAttente) {
    try {
      await deps.alertes.signaler(alerte);
      await deps.depot.transaction((tx) => tx.confirmerAlerte(id));
      confirmees++;
    } catch {
      // L'alerte reste non confirmée ; la suivante part quand même.
    }
  }
  return confirmees;
}

// Traite un fait du CRM (appelé par la tâche BullMQ, jobId = event_id). Le fait, son effet, ses alertes et son résultat sont écrits dans une seule transaction.
export function creerRecepteurC3(deps: DepsRecepteurC3) {
  const recepteur = {
    // Réception : valide, puis range le fait complet en base AVANT la mise en file (le job ne porte que l'identifiant).
    async recevoir(brut: unknown): Promise<{ eventId: string }> {
      const e = EvenementCrm.parse(brut) as unknown as FaitCrm;
      if (!Number.isSafeInteger(e.sequence)) throw new Error("sequence_hors_borne");
      await deps.depot.transaction((tx) => tx.recevoir(e));
      return { eventId: e.event_id };
    },
    // Tâche BullMQ : relit le fait rangé par son identifiant, puis le traite.
    async traiterParId(eventId: string): Promise<ResultatTraitement> {
      const contenu = await deps.depot.transaction((tx) => tx.contenu(eventId));
      if (contenu === null) throw new Error("fait_inconnu");
      return recepteur.traiter(contenu);
    },
    // Balayage : renvoie les alertes rangées non confirmées (panne du récepteur d'alertes), au plus `limite` par passage.
    async balayerAlertes(limite = 100): Promise<{ renvoyees: number }> {
      const lim = Math.min(Math.max(Math.trunc(limite), 1), 1000);
      const enAttente = await deps.depot.transaction((tx) => tx.alertesEnAttente(lim));
      return { renvoyees: await envoyer(deps, enAttente) };
    },
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
      await envoyer(deps, await deps.depot.transaction((tx) => tx.alertesNonConfirmees(e.event_id)));
      if (!issue) return { doublon: true };
      return { doublon: false, resultat: issue.resultat };
    },
  };
  return recepteur;
}
