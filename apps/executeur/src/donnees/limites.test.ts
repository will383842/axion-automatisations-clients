import { describe, expect, it } from "vitest";
import { lireLimitesDonnees } from "./limites.ts";

const BASE = { EXECUTEUR_DONNEES_HOTES: "pgbouncer-donnees.test" };

describe("limites du port données", () => {
  it("[A-170] les limites ont des valeurs par défaut sûres et se lisent de la configuration", () => {
    expect(lireLimitesDonnees(BASE)).toEqual({ delaiMs: 5000, delaiTotalMs: 15000, maxLignes: 200, hotes: ["pgbouncer-donnees.test"] });
    expect(lireLimitesDonnees({ ...BASE, EXECUTEUR_DONNEES_DELAI_MS: "800", EXECUTEUR_DONNEES_DELAI_TOTAL_MS: "2000", EXECUTEUR_DONNEES_MAX_LIGNES: "50", EXECUTEUR_DONNEES_HOTES: "a.test, b.test" })).toEqual({ delaiMs: 800, delaiTotalMs: 2000, maxLignes: 50, hotes: ["a.test", "b.test"] });
  });

  it("[A-170] une limite hors bornes, non numérique ou une liste d'hôtes absente ou illisible est refusée au démarrage", () => {
    for (const env of [
      { ...BASE, EXECUTEUR_DONNEES_DELAI_MS: "0" }, { ...BASE, EXECUTEUR_DONNEES_DELAI_MS: "60001" }, { ...BASE, EXECUTEUR_DONNEES_DELAI_MS: "5s" }, { ...BASE, EXECUTEUR_DONNEES_DELAI_TOTAL_MS: "0" }, { ...BASE, EXECUTEUR_DONNEES_DELAI_TOTAL_MS: "300001" },
      { ...BASE, EXECUTEUR_DONNEES_MAX_LIGNES: "201" }, { ...BASE, EXECUTEUR_DONNEES_MAX_LIGNES: "-1" },
      {}, { EXECUTEUR_DONNEES_HOTES: "" }, { EXECUTEUR_DONNEES_HOTES: "a.test,,b.test" }, { EXECUTEUR_DONNEES_HOTES: "a.test:5432" }, { EXECUTEUR_DONNEES_HOTES: "a b" },
    ]) expect(() => lireLimitesDonnees(env), JSON.stringify(env)).toThrow();
  });
});
