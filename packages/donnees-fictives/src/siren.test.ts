import { describe, expect, it } from "vitest";
import { creerGenerateur } from "./graine.js";
import { genererSiren, genererSiret, luhnValide } from "./siren.js";

describe("siren", () => {
  it("[C-532] chaque SIREN et SIRET généré a une clé de Luhn valide", () => {
    const g = creerGenerateur(7);
    for (let i = 0; i < 200; i++) {
      const siren = genererSiren(g);
      const siret = genererSiret(g, siren);
      expect(siren).toMatch(/^\d{9}$/);
      expect(siret).toMatch(/^\d{14}$/);
      expect(siret.startsWith(siren)).toBe(true);
      expect(luhnValide(siren)).toBe(true);
      expect(luhnValide(siret)).toBe(true);
    }
  });
  it("[C-532] luhnValide refuse un numéro dont la clé est fausse", () => {
    const siren = genererSiren(creerGenerateur(1));
    const faux = siren.slice(0, 8) + String((Number(siren[8]) + 1) % 10);
    expect(luhnValide(faux)).toBe(false);
  });
});
