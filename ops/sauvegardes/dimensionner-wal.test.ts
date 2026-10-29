import { describe, expect, it } from "vitest";
import { dimensionnerWal, seuilAlerteWal, DUREE_PAR_DEFAUT_MIN, PART_ALERTE_VOLUME } from "./dimensionner-wal.ts";
import { decider } from "../surveillance/disque.ts";

const Mo = 1024 * 1024;
// Valeurs FICTIVES : le débit maximal réel est mesuré en T1B-09 / T8A-10, il n'a pas de valeur de production ici.
const ENTREES = { plafondFile: 4096 * Mo, debitMaxOctetsParSeconde: 2 * Mo, maxWalSize: 1024 * Mo };

describe("dimensionnement du volume pg_wal", () => {
  it("[C-602] le dimensionnement de pg_wal vaut plafond de file plus débit maximal fois durée plus marge", () => {
    expect(DUREE_PAR_DEFAUT_MIN).toBe(10);
    // 4096 Mo + (2 Mo/s × 600 s = 1200 Mo) + 1024 Mo
    expect(dimensionnerWal(ENTREES)).toBe(4096 * Mo + 1200 * Mo + 1024 * Mo);
    // La durée est une variable.
    expect(dimensionnerWal({ ...ENTREES, dureeMinutes: 5 })).toBe(4096 * Mo + 600 * Mo + 1024 * Mo);
    // Sans débit, il reste le plafond plus la marge.
    expect(dimensionnerWal({ ...ENTREES, debitMaxOctetsParSeconde: 0 })).toBe(4096 * Mo + 1024 * Mo);
  });

  it("[C-602] le dimensionnement refuse une entrée négative ou non finie", () => {
    expect(() => dimensionnerWal({ ...ENTREES, plafondFile: -1 })).toThrow();
    expect(() => dimensionnerWal({ ...ENTREES, debitMaxOctetsParSeconde: Number.NaN })).toThrow();
    expect(() => dimensionnerWal({ ...ENTREES, dureeMinutes: Infinity })).toThrow();
  });

  it("[C-602] l'alerte d'occupation de pg_wal part avant le plafond de la file", () => {
    const volume = dimensionnerWal(ENTREES);
    const seuil = seuilAlerteWal(volume, ENTREES.plafondFile);
    expect(seuil).toBeCloseTo(volume * PART_ALERTE_VOLUME, 0);
    expect(seuil).toBeLessThan(ENTREES.plafondFile);
    // La sonde (decider) alerte bien à ce seuil, tant que la file n'a pas atteint son plafond.
    const d = decider(
      [{ t: 0, utilises: seuil, total: volume, journauxEnAttente: seuil }],
      { seuilAlerte: PART_ALERTE_VOLUME, plafondJournaux: ENTREES.plafondFile, horizonReveilMs: 6 * 3_600_000 },
      0,
    );
    expect(d.niveau).not.toBe("rien");
    expect(d.niveau).not.toBe("plafond_atteint");
  });

  it("[C-602] un volume trop petit pour que le seuil reste sous le plafond est refusé", () => {
    expect(() => seuilAlerteWal(100 * Mo, 40 * Mo)).toThrow();
  });
});
