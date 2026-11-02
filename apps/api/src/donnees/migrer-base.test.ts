import { describe, expect, it } from "vitest";
import { migrationsAAppliquer, migrerBase, verifierRole } from "./migrer-base.ts";

const E = (n: number, empreinte = `h${n}`) => ({ version: n, tag: `000${n - 1}_x`, empreinte });

describe("outil de migration des bases des clients", () => {
  it("[A-174] migrerBase applique dans l'ordre les migrations manquantes et met la version à jour", () => {
    const entrees = [E(1), E(2), E(3)];
    expect(migrationsAAppliquer(entrees, [], 3).map((e) => e.version)).toEqual([1, 2, 3]);
    expect(migrationsAAppliquer(entrees, [{ version: 1, empreinte: "h1" }], 3).map((e) => e.version)).toEqual([2, 3]);
    expect(migrationsAAppliquer(entrees, [{ version: 1, empreinte: "h1" }, { version: 2, empreinte: "h2" }], 2)).toEqual([]);
    expect(migrationsAAppliquer(entrees, [], 2).map((e) => e.version)).toEqual([1, 2]);
  });

  it("[A-174] une version cible inconnue ou une migration déjà appliquée dont le fichier a changé est refusée", () => {
    const entrees = [E(1), E(2)];
    expect(() => migrationsAAppliquer(entrees, [], 3)).toThrow(/version cible/);
    expect(() => migrationsAAppliquer(entrees, [], 0)).toThrow(/version cible/);
    expect(() => migrationsAAppliquer(entrees, [{ version: 1, empreinte: "autre" }], 2)).toThrow(/empreinte/);
    expect(() => migrationsAAppliquer(entrees, [{ version: 2, empreinte: "h2" }], 2)).toThrow(/trou/);
  });

  it("[A-212] migrerBase refuse de tourner avec le rôle application", async () => {
    const base = "cli_0a0a0a0a0a0a";
    for (const role of [`${base}_app`, `${base}_lecture`, "console_app"]) {
      expect(() => verifierRole(base, `postgres://${role}:x@localhost:5432/${base}`)).toThrow(/rôle/);
      await expect(migrerBase(base, 1, { url: `postgres://${role}:x@localhost:5432/${base}` })).rejects.toThrow(/rôle/);
    }
    expect(() => verifierRole(base, `postgres://migrateur:x@localhost:5432/${base}`)).not.toThrow();
  });

  it("[A-212] migrerBase refuse un nom de base qui n'est pas cli_<12 hexadécimaux> et PgBouncer", async () => {
    await expect(migrerBase("console", 1, { url: "postgres://migrateur:x@localhost:5432/console" })).rejects.toThrow(/nom de base/);
    await expect(migrerBase("cli_0a0a0a0a0a0a", 1, { url: "postgres://migrateur:x@pgbouncer-donnees:6432/cli_0a0a0a0a0a0a" })).rejects.toThrow(/directe/);
  });
});
