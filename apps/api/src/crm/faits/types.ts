// Ports du récepteur C3 : le récepteur ne connaît ni SQL ni file ; l'adaptateur SQL (tables de T2-02) les remplit.
export type ResultatFait = "traite" | "ignore" | "a_trancher" | "erreur";
export interface OrganisationLue {
  id: string;
  raisonSociale: string;
  siren: string | null;
  crmCompanyId: string | null;
}
export type MotifATrancher = "siren_absent_ressemblance" | "fiche_absorbee";
export interface EcartPropose {
  champ: "raison_sociale";
  valeurHub: string;
  valeurCrm: string;
}
// Tout ce qui est écrit pour un fait l'est dans UNE transaction (fait rangé, effet, résultat).
export interface TxC3 {
  rangerFait(f: { eventId: string; type: string; sequence: number; sujet: string }): Promise<boolean>;
  marquerTraite(eventId: string, resultat: ResultatFait): Promise<void>;
  organisationParCrm(crmCompanyId: string): Promise<OrganisationLue | null>;
  organisationsParSiren(siren: string): Promise<OrganisationLue[]>;
  lierCrm(orgId: string, crmCompanyId: string): Promise<void>;
  rangerCopieCrm(orgId: string, copie: { raisonSociale?: string; adresse?: object }): Promise<void>;
  proposerEcart(orgId: string, ecart: EcartPropose): Promise<void>;
  signalerATrancher(orgId: string | null, motif: MotifATrancher): Promise<void>;
  noterApporteur(orgId: string, apporteurId: string): Promise<void>;
  absorber(orgId: string, absorbee: string, gardee: string): Promise<void>;
  // Ajoute l'empreinte aux exclusions de chaque client dont un contact la porte ; renvoie le nombre de clients touchés.
  exclure(empreinte: string, motif: "desabonnement" | "demande_client"): Promise<number>;
  // Lien CRM absorbé : renvoie l'identifiant de la fiche gardée, sinon null.
  gardeeDe(crmCompanyId: string): Promise<string | null>;
}
export interface DepotC3 {
  transaction<T>(fn: (tx: TxC3) => Promise<T>): Promise<T>;
}
// Alertes sans donnée de personne : seulement un type et une référence (empreinte ou identifiant du CRM).
export interface AlerteC3 {
  type: "exclusion_a_reporter_dans_le_hub" | "effacement_demande" | "ecart_propose" | "fait_hors_perimetre";
  reference: string;
}
export interface AlertesC3 {
  signaler(a: AlerteC3): Promise<void>;
}

// Formes des faits du CRM (C3). Le contrat valide à l'entrée ; ces types ne servent qu'à discriminer sans recopier les schémas.
interface Base { event_id: string; sequence: number; subject_ref: { crmCompanyId: string } }
export type FaitCrm = Base &
  (
    | { event_type: "entreprise.devenue_cliente"; payload: { crmCompanyId: string; siren: string } }
    | { event_type: "entreprise.mise_a_jour"; payload: { crmCompanyId: string; raisonSociale?: string; adresse?: object } }
    | { event_type: "apporteur.rattache"; payload: { crmCompanyId: string; apporteurId: string } }
    | { event_type: "fiche.fusionnee"; payload: { crmCompanyIdAbsorbee: string; crmCompanyIdGardee: string } }
    | { event_type: "consentement.retire" | "effacement.demande"; payload: { emailEmpreinte: string } }
  );
export type FaitDe<T extends FaitCrm["event_type"]> = Extract<FaitCrm, { event_type: T }>;
