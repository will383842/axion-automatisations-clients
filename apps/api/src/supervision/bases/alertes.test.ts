import { describe, expect, it } from "vitest";
import { alertesBase } from "./alertes.js";

const base = { base: "cli_lemoine", debut: new Date(), tailleOctets: 1, quotaOctets: 100, connexions: 6, limiteConnexions: 20, requetesLentes: 0, lignesMortes: 100, versionStructure: "modele_v1", ageSauvegardeS: 1, ageTestRestaurationS: 1 };

describe("alertes des bases", () => {
  it("[A-263] connexions au-delà de 80 % de la limite de la base → alerte", () => {
    expect(alertesBase({ ...base, connexions: 17 }, {}).map((a) => a.raison)).toEqual(["connexions_80_pourcent"]);
    expect(alertesBase({ ...base, connexions: 16 }, {})).toEqual([]);
  });
  it("[A-263] lignes mortes au-delà du seuil configuré → alerte ; sans seuil, aucune alerte inventée", () => {
    expect(alertesBase({ ...base, lignesMortes: 5_000 }, { lignesMortesMax: 1_000 }).map((a) => a.raison)).toEqual(["lignes_mortes_elevees"]);
    expect(alertesBase({ ...base, lignesMortes: 5_000 }, {})).toEqual([]);
  });
  it("[A-263] une limite de connexions inconnue (0) ne divise pas par zéro", () => {
    expect(alertesBase({ ...base, connexions: 5, limiteConnexions: 0 }, {})).toEqual([]);
  });
});
