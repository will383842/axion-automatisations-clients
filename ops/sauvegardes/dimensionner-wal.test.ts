import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
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

// L'essai de rafale doit éprouver la définition de production du volume pg_wal, pas une variante : ces tests comparent les deux fichiers
// sans Docker et échouent si l'essai se met à détourner le volume (autre dossier des journaux, volume en mémoire monté ailleurs).
describe("l'essai de rafale exerce la définition de production du volume pg_wal", () => {
  interface Compose {
    services: Record<string, { environment?: Record<string, string>; volumes?: string[]; tmpfs?: string[] }>;
    volumes?: Record<string, { driver_opts?: { type?: string; o?: string } }>;
  }
  const charger = (f: string) => load(readFileSync(fileURLToPath(new URL(`../socle/${f}`, import.meta.url)), "utf8")) as Compose;
  const prod = charger("compose.sauvegardes.yml");
  const essai = charger("compose.zz-essai-disque.yml");
  const env = (c: Compose) => c.services.postgres.environment!;
  const montage = prod.services.postgres.volumes!.find((v) => v.startsWith("pg-wal:"))!.split(":")[1];
  const tailleEssai = () => {
    const o = String(essai.volumes?.["pg-wal"]?.driver_opts?.o ?? "");
    const m = /(?:^|,)size=(\d+)m(?:,|$)/.exec(o);
    return m ? Number(m[1]) * Mo : NaN;
  };

  it("[C-602] l'essai ne remplace ni le dossier des journaux ni le montage de pg_wal", () => {
    expect(env(prod).POSTGRES_INITDB_WALDIR.startsWith(`${montage}/`)).toBe(true);
    expect(env(essai).POSTGRES_INITDB_WALDIR).toBeUndefined();
    expect(essai.services.postgres.tmpfs).toBeUndefined();
    expect(essai.services.postgres.volumes).toBeUndefined();
    expect(Object.keys(essai.services)).toEqual(["postgres"]);
  });

  it("[C-602] l'essai borne le volume pg-wal de production lui-même, et seul le plafond et max_wal_size changent", () => {
    expect(essai.volumes!["pg-wal"].driver_opts!.type).toBe("tmpfs");
    expect(tailleEssai()).toBeGreaterThan(0);
    const sans = (p: string) => p.replace(/ -c (max|min)_wal_size=\S+/g, "");
    expect(sans(env(essai).P)).toBe(env(prod).P);
    expect(Object.keys(env(essai)).sort()).toEqual(["P", "PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX"]);
  });

  it("[C-602] la taille du volume d'essai respecte la règle de dimensionnement avec son plafond et son max_wal_size", () => {
    const plafond = Number(/^(\d+)MiB$/.exec(env(essai).PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX)![1]) * Mo;
    const maxWal = Number(/max_wal_size=(\d+)MB/.exec(env(essai).P)![1]) * Mo;
    expect(tailleEssai()).toBeGreaterThanOrEqual(dimensionnerWal({ plafondFile: plafond, debitMaxOctetsParSeconde: 0, maxWalSize: maxWal }));
  });

  it("[C-602] l'essai d'intégration lit les journaux au dossier de production", () => {
    const t = readFileSync(fileURLToPath(new URL("../../tests/socle/sauvegardes.int.test.ts", import.meta.url)), "utf8");
    expect(/const WAL = "([^"]+)"/.exec(t)![1]).toBe(env(prod).POSTGRES_INITDB_WALDIR);
  });
});
