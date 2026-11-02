import { resoudre as resoudrePaquet } from "@axion-auto/reglages-heritage";
import { describe, expect, it } from "vitest";
import { typeCondition } from "../db/schema/canaux.ts";
import { CLES_HERITABLES, TYPE_VERS_CLES, remiseBps, resoudre } from "./heritage.ts";

const MAX = Number.MAX_SAFE_INTEGER;

describe("héritage commercial", () => {
  it("[A-160] @argent une remise en points de base s'arrondit vers le bas, sans flottant (bornes 0, 1, 9999, 10000)", () => {
    // 12345 × bps / 10000, arrondi vers le bas : 0, 1, 12343 (12343,7655), 12345.
    expect([0, 1, 9999, 10000].map((bps) => remiseBps(12345, bps))).toEqual([0, 1, 12343, 12345]);
    expect(remiseBps(0, 9999)).toBe(0);
    expect(remiseBps(9999, 1)).toBe(0);
    expect(remiseBps(10000, 1)).toBe(1);
    // Un flottant donnerait ici 4503599627370495,5… : le calcul en bigint reste exact aux bornes.
    expect(remiseBps(MAX, 9999)).toBe(Number((BigInt(MAX) * 9999n) / 10000n));
    expect(remiseBps(MAX, 10000)).toBe(MAX);
    expect(remiseBps(MAX, 0)).toBe(0);
  });

  it("[A-160] @argent un montant ou un taux hors bornes est refusé, jamais arrondi en silence", () => {
    for (const bps of [-1, 10001, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => remiseBps(100, bps)).toThrow(/taux/);
    for (const montant of [-1, 0.5, MAX + 1, Number.NaN, 2 ** 60]) expect(() => remiseBps(montant, 100)).toThrow(/montant/);
  });

  it("[B-515] la même entrée rend la même valeur et la même origine dans l'API et dans T4-30 (une seule fonction)", () => {
    expect(resoudre).toBe(resoudrePaquet);
    const niveaux = { global: { delai_jours: { valeur: 5, version: 2 } }, client: { delai_jours: { valeur: 9, version: 4 } } };
    expect(resoudre("delai_jours", niveaux)).toEqual(resoudrePaquet("delai_jours", niveaux));
  });

  it("[A-160] la liste des clés héritables est fermée et couvre chaque type de condition une seule fois", () => {
    const attribuees = Object.values(TYPE_VERS_CLES).flat();
    expect(new Set(attribuees).size).toBe(attribuees.length);
    expect([...attribuees].sort()).toEqual([...CLES_HERITABLES].filter((c) => attribuees.includes(c)).sort());
    expect(Object.keys(TYPE_VERS_CLES).sort()).toEqual([...typeCondition.enumValues].sort());
    for (const cles of Object.values(TYPE_VERS_CLES)) expect(cles.length).toBeGreaterThan(0);
  });
});
