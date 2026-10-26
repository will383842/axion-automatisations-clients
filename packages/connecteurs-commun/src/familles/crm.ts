import type { Capacite } from "../capacites.ts";
import type { DeclarationConnecteur } from "../famille.ts";
import type { JetonCourt } from "../jeton.ts";

export const ACTIONS_CRM = ["chercher_contact", "ajouter_contact"] as const;

export interface ConnecteurCrm {
  declaration: DeclarationConnecteur & { capacites: Capacite[] };
  chercherContact(jeton: JetonCourt, email: string): Promise<{ id: string; email: string } | null>;
  ajouterContact(jeton: JetonCourt, contact: { cle: string; email: string; nom: string }): Promise<{ id: string }>;
}
