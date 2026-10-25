import type { Capacite } from "../capacites.ts";
import type { DeclarationConnecteur } from "../famille.ts";
import type { JetonCourt } from "../jeton.ts";

export const CHAMPS_LISIBLES = ["expediteur", "objet", "corps", "date", "etiquettes"] as const;
export type Champ = (typeof CHAMPS_LISIBLES)[number];
export type MessageLu = Partial<Record<Champ, string | string[]>> & { id: string };
export type MessageSortant = { messageId: string; destinataire: string; objet: string; corps: string };
export type Page = { ids: string[]; suivant: string | null };

// Message-ID choisi par le moteur à la création : sans lui, pas de vérification après coup.
const MESSAGE_ID = /^<[A-Za-z0-9._+-]{1,100}@[A-Za-z0-9.-]{1,100}>$/;
export function verifierMessageId(v: string): string {
  if (!MESSAGE_ID.test(v)) throw new Error("Message-ID invalide");
  return v;
}

export interface ConnecteurMessagerie {
  declaration: DeclarationConnecteur & { capacites: Capacite[] };
  listerNouveaux(jeton: JetonCourt, curseur: string | null): Promise<Page>;
  lire(jeton: JetonCourt, id: string, champs: Champ[]): Promise<MessageLu>;
  etiqueter(jeton: JetonCourt, id: string, etiquettes: string[]): Promise<void>;
  creerBrouillon(jeton: JetonCourt, message: MessageSortant): Promise<{ id: string }>;
  envoyer(jeton: JetonCourt, message: MessageSortant): Promise<{ id: string }>;
}
