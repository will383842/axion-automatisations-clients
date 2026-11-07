import { describe, expect, it } from "vitest";
import { coutIaDuJour, coutIaDuMois, pourcentBudget, type LigneCoutIa } from "./cout-ia.js";

const maintenant = new Date("2026-11-07T12:00:00Z");
const l = (jour: string, c: number): LigneCoutIa => ({ jour, coutMicroCentimes: c });

describe("coût d'IA", () => {
  it("[B-386] le coût du jour et du mois s'additionne en micro-centimes entiers", () => {
    const lignes = [l("2026-11-07", 300), l("2026-11-07", 200), l("2026-11-02", 1_000), l("2026-10-31", 9_999)];
    expect(coutIaDuJour(lignes, maintenant)).toBe(500);
    expect(coutIaDuMois(lignes, maintenant)).toBe(1_500);
  });
  it("[B-386] coût à 80,01 % du budget → 8 001 points de base ; sans budget → sans objet", () => {
    expect(pourcentBudget(8_001, 10_000)).toBe(8_001);
    expect(pourcentBudget(8_000, 10_000)).toBe(8_000);
    expect(pourcentBudget(5, 0)).toBeNull();
  });
  it("[B-386] un coût non entier est refusé", () => {
    expect(() => coutIaDuJour([l("2026-11-07", 0.5)], maintenant)).toThrow();
  });
});
