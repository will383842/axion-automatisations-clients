import { describe, expect, it } from "vitest";
import { Centimes } from "../commun/argent.js";
import { STATUT_PAR_CODE } from "../commun/erreurs.js";
import { ROUTES_C1 } from "./routes.js";
import { verifierLigneDevis } from "./regles.js";
import { DevisRequete } from "./schemas.js";

const ligne = { libelle: "Ligne d'essai", quantite: 1, prixUnitaireHtCentimes: 12345, activite: "automatisation", tauxTvaBps: 2000 } as const;

describe("contrat C1", () => {
  it("[LOT0-c1] C1 compte 9 routes", () => {
    expect(Object.keys(ROUTES_C1)).toHaveLength(9);
  });

  it("[A-092] aucune route de C1 ne contient « pause »", () => {
    for (const [nom, r] of Object.entries(ROUTES_C1)) {
      expect(`${nom} ${r.chemin}`.toLowerCase()).not.toContain("pause");
    }
  });

  it("[C-546] une ligne à tauxTvaBps 0 est refusée en 422 tva_interdite", () => {
    expect(DevisRequete.safeParse({ referencePropositionConsole: "prop-1", lignes: [{ ...ligne, tauxTvaBps: 0 }] }).success).toBe(true);
    expect(verifierLigneDevis({ ...ligne, tauxTvaBps: 0 })).toEqual({ code: "tva_interdite", statut: 422 });
    expect(STATUT_PAR_CODE.tva_interdite).toBe(422);
    expect(verifierLigneDevis(ligne)).toBeNull();
  });

  it("[LOT0-c1] montant flottant refusé", () => {
    expect(Centimes.safeParse(12345).success).toBe(true);
    expect(Centimes.safeParse(123.45).success).toBe(false);
    expect(DevisRequete.safeParse({ referencePropositionConsole: "prop-1", lignes: [{ ...ligne, prixUnitaireHtCentimes: 100.5 }] }).success).toBe(false);
  });

  it("[LOT0-c1] les codes d'erreur sont fermés avec leur statut HTTP", () => {
    expect(STATUT_PAR_CODE).toMatchObject({ identifiant_deja_pris: 409, fiche_absorbee: 422, cle_reutilisee: 409, porte_fermee: 503, debit_depasse: 429 });
    expect(Object.keys(STATUT_PAR_CODE)).toHaveLength(14);
  });
});
