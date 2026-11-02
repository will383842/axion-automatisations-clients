import { identifiantEvenementC3 } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.ts";
import { EvenementConsole } from "../../../../packages/contrats/src/c3/evenements-console-vers-crm.ts";
import { ROUTES_C3 } from "../../../../packages/contrats/src/c3/lecture-entreprise.ts";
import { journaliser, type Journal } from "../canaux/journal-canal.ts";
import { statutCrmDepuisConsole, type StatutConsole } from "./statuts.ts";

// Faits C3 console → CRM (C-346). Chaque fait est déposé dans la boîte d'envoi DANS la transaction du changement :
// l'appelant fournit `deposer`, lié à cette transaction (boite-envoi.deposer, T2-14). Aucun montant ne sort jamais (minimisation).
export interface DepotC3 { destination: "crm"; route: string; methode: "POST"; corps: unknown; intention: string }
export type Deposeur = (depot: DepotC3) => Promise<{ nouveau: boolean }>;
export interface DepotsC3 { deposer: Deposeur; tenantId: string; journal?: Journal; idTrace: string }
// `id` identifie le changement métier (même id = même fait) ; `occurredAt` est la date du changement : le corps reste identique au rejeu.
export interface IntentionC3 { id: string; occurredAt: string; sequence?: number }
export interface ResultatFait { eventId: string; nouveau: boolean }
export interface AbonnementResume { codeAutomatisation: string; palier: string; periodeMois: number; terme: string; prochaineEcheance: string }

export function emetteurC3(d: DepotsC3) {
  async function fait(type: string, i: IntentionC3, tenant: string, payload: unknown): Promise<ResultatFait> {
    const eventId = identifiantEvenementC3(type, `${tenant}:${i.id}`);
    const corps = EvenementConsole.parse({
      event_id: eventId, schema_version: 1, occurred_at: i.occurredAt, emitted_at: i.occurredAt, sequence: i.sequence ?? 0,
      producer: "axion-console", subject_ref: { consoleClientId: tenant }, event_type: type, payload,
    });
    const { nouveau } = await d.deposer({ destination: "crm", route: ROUTES_C3.consoleVersCrm.chemin, methode: "POST", corps, intention: `c3:${type}:${i.id}` });
    // Une ligne par fait, sans corps (C-344).
    journaliser(d.journal, { canal: "c3", sens: "sortant", route: ROUTES_C3.consoleVersCrm.chemin, cle: eventId, horodatage: undefined, resultat: nouveau ? "depose" : "deja_depose", id_trace: d.idTrace });
    return { eventId, nouveau };
  }
  const c = (tenant: string) => ({ consoleClientId: tenant });
  return {
    clientCree: (i: IntentionC3, t: string, crmCompanyId: string) => fait("client.cree", i, t, { ...c(t), crmCompanyId }),
    // Part au passage de statut ; null quand le CRM n'a rien à recevoir (prospect, en_signature).
    statutClient: async (i: IntentionC3, t: string, statut: StatutConsole): Promise<ResultatFait | null> => {
      const { fait: valeur } = statutCrmDepuisConsole(statut);
      return valeur === null ? null : fait("client.statut", i, t, { ...c(t), statut: valeur });
    },
    // Les champs sont recopiés un par un : un montant ou un prix fourni en trop ne sort jamais.
    planResume: (i: IntentionC3, t: string, abonnements: readonly AbonnementResume[]) =>
      fait("plan.resume", i, t, { ...c(t), abonnements: abonnements.map((a) => ({ codeAutomatisation: a.codeAutomatisation, palier: a.palier, periodeMois: a.periodeMois, terme: a.terme, prochaineEcheance: a.prochaineEcheance })) }),
    renouvellementProche: (i: IntentionC3, t: string, dateRenouvellement: string) => fait("renouvellement.proche", i, t, { ...c(t), dateRenouvellement }),
    impayeSignale: (i: IntentionC3, t: string, joursRetard: number) => fait("impaye.signale", i, t, { ...c(t), joursRetard }),
    automatisationActivee: (i: IntentionC3, t: string, codeAutomatisation: string, dateActivation: string) => fait("automatisation.activee", i, t, { ...c(t), codeAutomatisation, dateActivation }),
    contratResilie: (i: IntentionC3, t: string, dateResiliation: string) => fait("contrat.resilie", i, t, { ...c(t), dateResiliation }),
  };
}
export type EmetteurC3 = ReturnType<typeof emetteurC3>;
