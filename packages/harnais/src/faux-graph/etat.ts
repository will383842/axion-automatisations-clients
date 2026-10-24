// État en mémoire du faux Microsoft 365 : brouillons, Éléments envoyés, mode de panne.

export type Mode = "normal" | "quota" | "reponse_perdue" | "panne_generale" | "consentement_admin_requis";
export const MODES: readonly Mode[] = ["normal", "quota", "reponse_perdue", "panne_generale", "consentement_admin_requis"];

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
};

export const nouvelEtat = (): EtatGraph => ({ mode: "normal", brouillons: new Map(), envoyes: [] });
