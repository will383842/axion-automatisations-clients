import { describe, expect, it } from "vitest";
import { baseEnRetard, codeVersion } from "./structure.js";

describe("version de structure", () => {
  it("[B-388] une base en modele_v1 pendant une vague vers v2 est signalée", () => {
    expect(baseEnRetard("modele_v1", "modele_v2")).toBe(true);
    expect(baseEnRetard("modele_v2", "modele_v2")).toBe(false);
  });
  it("[B-388] sans vague en cours aucune base n'est en retard", () => {
    expect(baseEnRetard("modele_v1", null)).toBe(false);
  });
  it("[B-388] le code de version vient de la plus haute version appliquée", () => {
    expect(codeVersion([1, 2, 3])).toBe("modele_v3");
    expect(codeVersion([])).toBe("modele_v0");
  });
  it("[B-388] une version illisible est refusée plutôt que comparée", () => {
    expect(() => baseEnRetard("v1", "modele_v2")).toThrow(/version/);
  });
});
