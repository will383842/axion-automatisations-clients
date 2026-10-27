import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_MIGRATIONS } from "../../../../packages/contrats/src/c5/invariants.js";
import { JOURNAL_PAR_DEFAUT, migrationsSautees, migrer, VERROU_MIGRATION } from "./migrer.js";

describe("outil de migration", () => {
  it("[A-189] attaque : migrer refuse l'URL du rôle applicatif avant toute connexion", async () => {
    for (const url of [
      "postgres://console_app@db.test:5432/console",
      "postgres://db.test:5432/console",
      "postgres://console_migration@db.test:5432/console?user=console_app",
      "pas une url",
    ]) {
      await expect(migrer({ url, dossier: "/inexistant" }), url).rejects.toThrow(/console_migration/);
    }
  });

  it("[A-233] sonde 30 : migrer refuse un journal dont un tag sort du dossier, avant toute connexion", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "migrer-"));
    mkdirSync(join(dossier, "meta"));
    writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 0, tag: "../hors/0000_cache", breakpoints: true }] }));
    await expect(migrer({ url: "postgres://console_migration@hote.test:5432/console", dossier })).rejects.toThrow(/tag de journal invalide/);
  });

  it("[A-233] migrer refuse un DROP dans un fichier du journal, avant toute connexion", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "migrer-"));
    mkdirSync(join(dossier, "meta"));
    writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 0, tag: "0000_a", breakpoints: true }] }));
    writeFileSync(join(dossier, "0000_a.sql"), "DROP TABLE a;\n");
    await expect(migrer({ url: "postgres://console_migration@hote.test:5432/console", dossier })).rejects.toThrow(/instruction interdite : DROP/);
  });

  it("[A-189] migrer refuse un nom de journal hors de ^[a-z0-9_]+$, avant toute connexion", async () => {
    for (const journal of [
      { schema: "public; DROP TABLE a", table: "__migrations" },
      { schema: "essai", table: "Journal" },
      { schema: "", table: "__migrations" },
      { schema: "essai", table: "a-b" },
    ]) {
      await expect(migrer({ url: "postgres://console_migration@hote.test:5432/console", dossier: "/inexistant", journal }), JSON.stringify(journal)).rejects.toThrow(/nom de journal/);
    }
  });

  it("[A-189] le journal des migrations par défaut est public.__migrations et le verrou est celui de migrer", () => {
    expect(JOURNAL_PAR_DEFAUT).toEqual({ schema: "public", table: TABLE_MIGRATIONS });
    expect(TABLE_MIGRATIONS).toBe("__migrations");
    expect(typeof VERROU_MIGRATION).toBe("bigint");
  });

  it("[A-189] migrer refuse une URL qui vise PgBouncer, avant toute connexion", async () => {
    for (const url of ["postgres://console_migration@db.test:6432/console", "postgres://console_migration@pgbouncer.test:5432/console", "postgres://console_migration@PgBouncer:5432/console"]) {
      await expect(migrer({ url, dossier: "/inexistant" }), url).rejects.toThrow(/PgBouncer/);
    }
  });

  it("[A-189] une migration sous la date de la dernière appliquée, sans ligne au même hash, serait sautée : elle est signalée", () => {
    const appliquees = [{ created_at: 1000, hash: "h0" }, { created_at: 3000, hash: "h2" }];
    expect(migrationsSautees([{ tag: "0000_a", when: 1000, hash: "h0" }, { tag: "0001_b", when: 1500, hash: "h1" }, { tag: "0002_c", when: 3000, hash: "h2" }], appliquees)).toEqual(["0001_b"]);
    expect(migrationsSautees([{ tag: "0000_a", when: 1000, hash: "h0" }], [])).toEqual([]);
    expect(migrationsSautees([{ tag: "0000_a", when: 1000, hash: "h0" }, { tag: "0001_b", when: 3001, hash: "h1" }], appliquees)).toEqual([]);
    expect(migrationsSautees([{ tag: "0001_b", when: 3000, hash: "hx" }], appliquees)).toEqual(["0001_b"]);
  });
});
