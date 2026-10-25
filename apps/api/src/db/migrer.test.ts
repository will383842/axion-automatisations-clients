import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrer } from "./migrer.js";

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
    await expect(migrer({ url: "postgres://console_migration@hote.invalid:5432/console", dossier })).rejects.toThrow(/tag de journal invalide/);
  });

  it("[A-233] migrer refuse un DROP dans un fichier du journal, avant toute connexion", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "migrer-"));
    mkdirSync(join(dossier, "meta"));
    writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 0, tag: "0000_a", breakpoints: true }] }));
    writeFileSync(join(dossier, "0000_a.sql"), "DROP TABLE a;\n");
    await expect(migrer({ url: "postgres://console_migration@hote.invalid:5432/console", dossier })).rejects.toThrow(/instruction interdite : DROP/);
  });
});
