import type { Capacite } from "../capacites.ts";
import type { DeclarationConnecteur } from "../famille.ts";
import type { JetonCourt } from "../jeton.ts";

export const ACTIONS_AGENDA = ["lister_creneaux", "creer_evenement"] as const;

export interface ConnecteurAgenda {
  declaration: DeclarationConnecteur & { capacites: Capacite[] };
  listerCreneaux(jeton: JetonCourt, debut: string, fin: string): Promise<{ debut: string; fin: string }[]>;
  // La clé vient du moteur : même clé, même événement.
  creerEvenement(jeton: JetonCourt, evenement: { cle: string; debut: string; fin: string; titre: string }): Promise<{ id: string }>;
}
