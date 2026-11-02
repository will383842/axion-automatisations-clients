// Correspondance des statuts de la console et du CRM (C-324, annexe C3). `fait` est la valeur du fait client.statut,
// ou null quand aucun fait ne part. Le CRM voit « prospect » tant que le contrat n'est pas signé (statut en_signature) :
// C3 n'a pas de statut de plus. « dormant » n'existe que côté CRM : aucun statut de la console n'y mène.
export type StatutConsole = "prospect" | "en_signature" | "client" | "ancien_client";
export type FaitStatut = "client" | "perdu";
export interface LigneStatut { crm: "prospect" | "client" | "perdu"; fait: FaitStatut | null }

export const STATUTS_CRM_DEPUIS_CONSOLE: Readonly<Record<StatutConsole, LigneStatut>> = {
  prospect: { crm: "prospect", fait: null },
  en_signature: { crm: "prospect", fait: null },
  client: { crm: "client", fait: "client" },
  ancien_client: { crm: "perdu", fait: "perdu" },
};

export const statutCrmDepuisConsole = (s: StatutConsole): LigneStatut => STATUTS_CRM_DEPUIS_CONSOLE[s];
