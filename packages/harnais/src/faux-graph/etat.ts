import { nouveauTournant, type Tournant } from "./jeton-tournant.js";

// État en mémoire du faux Microsoft 365 : brouillons, Éléments envoyés, mode de panne.

export type Mode = "normal" | "quota" | "reponse_perdue" | "panne_generale" | "consentement_admin_requis" | "mauvais_compte";
export const MODES: readonly Mode[] = ["normal", "quota", "reponse_perdue", "panne_generale", "consentement_admin_requis", "mauvais_compte"];

export type Brouillon = {
  id: string;
  internetMessageId: string;
  compte: string;
  subject: string;
  contenu: string;
  type: "text" | "html";
  destinataires: string[];
};

export type EtatGraph = {
  mode: Mode;
  brouillons: Map<string, Brouillon>;
  envoyes: Brouillon[];
  // Consentement de l'administrateur PAR locataire (clé : « client_id|locataire »).
  consentementRequis: boolean;
  consentements: Set<string>;
  tournant: Tournant;
};

export const nouvelEtat = (): EtatGraph => ({ mode: "normal", brouillons: new Map(), envoyes: [], consentementRequis: false, consentements: new Set(), tournant: nouveauTournant() });
