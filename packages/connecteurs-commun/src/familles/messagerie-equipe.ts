import type { Capacite } from "../capacites.ts";
import type { DeclarationConnecteur } from "../famille.ts";
import type { JetonCourt } from "../jeton.ts";

export const ACTIONS_MESSAGERIE_EQUIPE = ["publier"] as const;

export interface ConnecteurMessagerieEquipe {
  declaration: DeclarationConnecteur & { capacites: Capacite[] };
  publier(jeton: JetonCourt, message: { cle: string; canal: string; texte: string }): Promise<{ id: string }>;
}
