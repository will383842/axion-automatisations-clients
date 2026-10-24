import { TVA_AUTOMATISATION_BPS } from "../commun/argent.ts";
import { STATUT_PAR_CODE } from "../commun/erreurs.ts";

// Règles métier de C1 : le schéma décrit la forme, ces fonctions refusent le fond.
export interface RefusRegle {
  code: "tva_interdite";
  statut: typeof STATUT_PAR_CODE.tva_interdite;
}

export function verifierLigneDevis(ligne: { activite: string; tauxTvaBps: number }): RefusRegle | null {
  if (ligne.activite === "automatisation" && ligne.tauxTvaBps !== TVA_AUTOMATISATION_BPS) {
    return { code: "tva_interdite", statut: STATUT_PAR_CODE.tva_interdite };
  }
  return null;
}
