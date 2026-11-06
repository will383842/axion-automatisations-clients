import { describe, expect, it } from "vitest";
import { empreinteScram, migrationsAAppliquer, migrerBase, verifierContracter, verifierRole } from "./migrer-base.ts";

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

  it("[A-232] en production, migrerBase refuse une cible plus basse que la version appliquée", () => {
    const entrees = [E(1), E(2), E(3)];
    const faits = [{ version: 1, empreinte: "h1" }, { version: 2, empreinte: "h2" }, { version: 3, empreinte: "h3" }];
    expect(() => migrationsAAppliquer(entrees, faits, 2, true)).toThrow(/descendante/);
    expect(migrationsAAppliquer(entrees, faits, 3, true)).toEqual([]);
    expect(migrationsAAppliquer(entrees, faits.slice(0, 1), 3, true).map((e) => e.version)).toEqual([2, 3]);
    expect(migrationsAAppliquer(entrees, faits, 2, false)).toEqual([]);
  });

  it("[A-232] sous NODE_ENV=production, migrerBase lit lui-même l'environnement : la descente n'est pas un choix de l'appelant", () => {
    const entrees = [E(1), E(2)];
    const faits = [{ version: 1, empreinte: "h1" }, { version: 2, empreinte: "h2" }];
    const avant = process.env["NODE_ENV"];
    try {
      process.env["NODE_ENV"] = "production";
      expect(() => migrationsAAppliquer(entrees, faits, 1)).toThrow(/descendante/);
      process.env["NODE_ENV"] = "test";
      expect(migrationsAAppliquer(entrees, faits, 1)).toEqual([]);
    } finally {
      if (avant === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = avant;
    }
  });

  it("[A-219] le mot de passe du rôle de migration d'un module part en empreinte SCRAM calculée côté client, jamais en clair dans le texte SQL", () => {
    const e = empreinteScram("secret-a-usage-unique");
    expect(e).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    expect(e).not.toContain("secret-a-usage-unique");
    expect(empreinteScram("secret-a-usage-unique")).not.toBe(e);
  });
});

describe("migrerBase : phase contracter", () => {
  const ouvert = { interrupteurOuvert: true, versionN: 2, versionsDesBases: [2, 2], versionCodeDeployee: 3 };
  const TEXTE = "-- phase: contracter\nALTER TABLE a DROP COLUMN x;";
  it("[A-230] un contracter sans lecteur d'état, ou dont l'état refuse, est refusé : un booléen de l'appelant ne suffit plus", async () => {
    await expect(verifierContracter("0002_x", 3, TEXTE, undefined)).rejects.toThrow(/contracter/);
    await expect(verifierContracter("0002_x", 3, TEXTE, (async () => ({ ...ouvert, interrupteurOuvert: false })))).rejects.toThrow(/interrupteur/);
    await expect(verifierContracter("0002_x", 3, TEXTE, (async () => ({ ...ouvert, versionsDesBases: [2, 1] })))).rejects.toThrow(/toutes les bases/);
    await expect(verifierContracter("0002_x", 3, TEXTE, (async () => ({ ...ouvert, versionCodeDeployee: 2 })))).rejects.toThrow(/code déployé/);
  });
  it("[A-226] le lecteur reçoit N, la version qui précède le contracter ; un fichier ordinaire n'appelle pas le lecteur", async () => {
    const vus: number[] = [];
    await verifierContracter("0002_x", 3, TEXTE, async (n) => { vus.push(n); return ouvert; });
    expect(vus).toEqual([2]);
    await verifierContracter("0001_x", 2, "ALTER TABLE a ADD COLUMN x int;", async (n) => { vus.push(n); return ouvert; });
    expect(vus).toEqual([2]);
  });
});
