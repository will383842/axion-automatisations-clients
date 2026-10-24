import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyserSource, comparerCompte, compterRapport } from "./compter-tests.js";

const source = (nom: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/sources/${nom}`, import.meta.url)), "utf8");

describe("compter-tests", () => {
  it("compte les tests du rapport Vitest JSON", () => {
    expect(compterRapport({ numTotalTests: 42 })).toBe(42);
  });
  it("[C-538] compter-tests refuse une baisse", () => {
    expect(comparerCompte(41, 42)).not.toEqual([]);
    expect(comparerCompte(42, 42)).toEqual([]);
    expect(comparerCompte(43, 42)).toEqual([]);
  });
  it("[C-538] compter-tests refuse un .skip sans fiche", () => {
    expect(analyserSource("a.test.ts", source("skip-sans-fiche.txt"))).not.toEqual([]);
  });
  it("[C-538] compter-tests accepte un .skip avec fiche ou l'étiquette [V2]", () => {
    expect(analyserSource("a.test.ts", source("skip-avec-fiche.txt"))).toEqual([]);
  });
  it("[C-538] compter-tests refuse retry sur un test @argent", () => {
    expect(analyserSource("a.test.ts", source("retry-argent.txt"))).not.toEqual([]);
  });
  it("[C-538] compter-tests laisse passer un test @argent sans retry et un retry ordinaire", () => {
    expect(analyserSource("a.test.ts", source("retry-ok.txt"))).toEqual([]);
  });
  it("[C-538] compter-tests refuse test.fails sans étiquette @lot-<n>", () => {
    expect(analyserSource("a.test.ts", source("fails-sans-lot.txt"))).not.toEqual([]);
    expect(analyserSource("a.test.ts", source("fails-avec-lot.txt"))).toEqual([]);
  });
});
