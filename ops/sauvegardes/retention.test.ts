import { describe, expect, it } from "vitest";
import { calculerRetention, completesDepuisInfo, ensemblesAExpirer, type Sauvegarde } from "./retention.ts";

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

  it("[C-049] une sauvegarde datée après aujourd'hui n'expire jamais (lendemain, mois suivant)", () => {
    const futures = [
      { id: "2026-10-27-F", date: "2026-10-27T00:00:00Z" },
      { id: "2026-11-15-F", date: "2026-11-15T02:00:00Z" },
    ];
    const r = calculerRetention([...nuits(400), ...futures], AUJOURDHUI);
    expect(r.futures.map((s) => s.id)).toEqual(["2026-10-27-F", "2026-11-15-F"]);
    for (const f of futures) {
      expect(r.garder.map((s) => s.id)).toContain(f.id);
      expect(r.expirer.map((s) => s.id)).not.toContain(f.id);
    }
    // La fin du jour courant reste « aujourd'hui » : 23:59 UTC du 26 est une quotidienne, pas une future.
    const tard = calculerRetention([{ id: "tard", date: "2026-10-26T23:59:59Z" }], AUJOURDHUI);
    expect(tard.futures).toHaveLength(0);
    expect(tard.quotidiennes).toHaveLength(1);
  });

  it("[C-049] la plus récente est toujours gardée, même si l'horloge avance de plusieurs années", () => {
    const r = calculerRetention(nuits(400), "2030-01-01");
    expect(r.garder.map((s) => s.id)).toEqual(["2026-10-26-F"]);
    expect(r.expirer).toHaveLength(399);
  });

  it("[C-049] les ensembles à expirer se lisent dans la sortie de pgbackrest info, complètes seulement", () => {
    const epoque = (iso: string) => Date.parse(iso) / 1000;
    const info = JSON.stringify([
      {
        name: "commun",
        backup: [
          { label: "20200101-020000F", type: "full", timestamp: { start: epoque("2020-01-01T02:00:00Z"), stop: epoque("2020-01-01T02:05:00Z") } },
          { label: "20200101-020000F_20200102-020000I", type: "incr", timestamp: { start: 1, stop: 2 } },
          { label: "20261026-020000F", type: "full", timestamp: { start: epoque("2026-10-26T02:00:00Z"), stop: epoque("2026-10-26T02:05:00Z") } },
        ],
      },
    ]);
    expect(completesDepuisInfo(info).map((s) => s.id)).toEqual(["20200101-020000F", "20261026-020000F"]);
    expect(ensemblesAExpirer(info, AUJOURDHUI)).toEqual(["20200101-020000F"]);
    expect(ensemblesAExpirer(info, "2020-01-02")).toEqual([]);
    expect(ensemblesAExpirer("[]", AUJOURDHUI)).toEqual([]);
  });

  it("[C-049] une sortie de pgbackrest info inattendue fait échouer plutôt qu'expirer", () => {
    expect(() => ensemblesAExpirer("pas du JSON", AUJOURDHUI)).toThrow();
    expect(() => ensemblesAExpirer('{"backup":[]}', AUJOURDHUI)).toThrow();
    expect(() => ensemblesAExpirer('[{"name":"commun"}]', AUJOURDHUI)).toThrow();
    expect(() => ensemblesAExpirer('[{"backup":[{"label":"x","type":"full"}]}]', AUJOURDHUI)).toThrow();
  });
});
