import type { Capacite } from "../capacites.ts";
import type { DeclarationConnecteur } from "../famille.ts";
import type { JetonCourt } from "../jeton.ts";

export const ACTIONS_COMPTABILITE = ["creer_facture_fournisseur_brouillon"] as const;

export interface ConnecteurComptabilite {
  declaration: DeclarationConnecteur & { capacites: Capacite[] };
  // Brouillon seulement : aucune action ne crée de document définitif (C-251).
  creerFactureFournisseur(jeton: JetonCourt, facture: { cle: string; fournisseur: string; montantCentimes: number }): Promise<{ id: string; statut: "brouillon" }>;
}
