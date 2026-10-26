import { describe, expect, it } from "vitest";
import { calculerRetention, type Sauvegarde } from "./retention.ts";

// Une sauvegarde complète par nuit, à 02:00 UTC, sur 400 jours simulés qui finissent le 2026-10-26.
const AUJOURDHUI = "2026-10-26";
const jour = (decalage: number) => new Date(Date.UTC(2026, 9, 26 - decalage));
const nuits = (n: number): Sauvegarde[] =>
  Array.from({ length: n }, (_, i) => {
    const d = jour(n - 1 - i);
    return { id: `${d.toISOString().slice(0, 10)}-F`, date: `${d.toISOString().slice(0, 10)}T02:00:00Z` };
  });

describe("rétention des sauvegardes complètes", () => {
  it("[C-049] la rétention garde 30 quotidiennes et 12 mensuelles sur 400 jours simulés", () => {
    const r = calculerRetention(nuits(400), AUJOURDHUI);
    expect(r.quotidiennes).toHaveLength(30);
    expect(r.mensuelles).toHaveLength(12);
    // Les 30 quotidiennes sont les 30 dernières nuits.
    expect(r.quotidiennes[0]?.id).toBe("2026-09-27-F");
    expect(r.quotidiennes[29]?.id).toBe("2026-10-26-F");
    // Chaque mensuelle est la dernière sauvegarde de son mois ; le mois en cours compte, avec la plus récente.
    expect(r.mensuelles.map((s) => s.id.slice(0, 7))).toEqual([
      "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ]);
    expect(r.mensuelles[0]?.id).toBe("2025-11-30-F");
    expect(r.mensuelles[11]?.id).toBe("2026-10-26-F");
  });

  it("[C-049] tout le reste est à expirer, rien n'est gardé deux fois", () => {
    const toutes = nuits(400);
    const r = calculerRetention(toutes, AUJOURDHUI);
    const gardees = new Set(r.garder.map((s) => s.id));
    expect(gardees.size).toBe(r.garder.length);
    expect(r.garder.length).toBe(30 + 10); // les mensuelles de septembre et d'octobre sont déjà des quotidiennes
    expect(r.expirer.length + r.garder.length).toBe(toutes.length);
    expect(r.expirer.every((s) => !gardees.has(s.id))).toBe(true);
  });

  it("[C-049] avec peu de sauvegardes, on garde tout sans en inventer", () => {
    const r = calculerRetention(nuits(5), AUJOURDHUI);
    expect(r.quotidiennes).toHaveLength(5);
    expect(r.expirer).toHaveLength(0);
  });

  it("[C-049] une date de sauvegarde illisible fait échouer le calcul plutôt que d'effacer", () => {
    expect(() => calculerRetention([{ id: "x", date: "pas une date" }], AUJOURDHUI)).toThrow();
  });
});
