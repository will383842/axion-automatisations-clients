// État en mémoire du faux Gmail : messages envoyés (libellé SENT) et mode de panne.

export type Mode = "normal" | "quota" | "reponse_perdue" | "panne_generale" | "acces_refuse";
export const MODES: readonly Mode[] = ["normal", "quota", "reponse_perdue", "panne_generale", "acces_refuse"];

export type MessageGmail = { id: string; compte: string; rfc822msgid: string; labelIds: string[] };
export type EtatGmail = { mode: Mode; envoyes: MessageGmail[] };

export const nouvelEtat = (): EtatGmail => ({ mode: "normal", envoyes: [] });
