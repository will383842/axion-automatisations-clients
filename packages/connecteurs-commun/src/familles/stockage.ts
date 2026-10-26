import type { Capacite } from "../capacites.ts";
import type { DeclarationConnecteur } from "../famille.ts";
import type { JetonCourt } from "../jeton.ts";

export const ACTIONS_STOCKAGE = ["lister", "lire", "deposer"] as const;

export interface ConnecteurStockage {
  declaration: DeclarationConnecteur & { capacites: Capacite[] };
  lister(jeton: JetonCourt, dossier: string): Promise<string[]>;
  lire(jeton: JetonCourt, chemin: string): Promise<{ nom: string; contenu: string }>;
  deposer(jeton: JetonCourt, document: { cle: string; dossier: string; nom: string; contenu: string }): Promise<{ id: string }>;
}
