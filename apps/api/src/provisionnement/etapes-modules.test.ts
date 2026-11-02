import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lireEntrees, verifierMigrationModule } from "../donnees/migrer-base.js";
import { contexteBase } from "./etapes-base.js";
import { etapesModules, type PortsModules } from "./etapes-modules.js";
import type { LigneBase } from "./machine.js";

const T = randomUUID();
const DOSSIER_ESSAI = fileURLToPath(new URL("../../../../tests/modules/essai/migrations", import.meta.url));
const ligne: LigneBase = { etat: "en_creation", etape: 5, grappe: "donnees-1", nomBase: "cli_x" };
function monter(instances: { code: string; version: number }[], appliquee: Record<string, number> = {}) {
  const migre: string[] = [];
  const ports: PortsModules = {
    instances: async () => instances,
    versionAppliquee: async (_b, code) => appliquee[code] ?? 0,
    migrer: async (nomBase, _g, m) => { migre.push(`${nomBase}:${m.code}:${m.version}`); appliquee[m.code] = m.version; },
  };
  const [etape] = etapesModules(ports);
  return { etape: etape!, migre, ctx: () => contexteBase(T, ligne) };
}

describe("étape 6 : migrations des modules", () => {
  it("[A-219] aucune instance : l'étape est faite sans rien appliquer", async () => {
    const m = monter([]);
    expect(m.etape.numero).toBe(6);
    expect(await m.etape.dejaFait(m.ctx())).toBe(true);
  });
  it("[A-219] chaque instance est migrée à sa version, une fois ; le rejeu ne refait rien", async () => {
    const m = monter([{ code: "essai", version: 1 }]);
    expect(await m.etape.dejaFait(m.ctx())).toBe(false);
    await m.etape.faire(m.ctx());
    expect(m.migre).toEqual([`${contexteBase(T, ligne).nomBase}:essai:1`]);
    expect(await m.etape.dejaFait(m.ctx())).toBe(true);
  });
  it("[A-219] un code de module qui n'est pas un nom simple est refusé avant tout appel", async () => {
    const m = monter([{ code: 'essai"; DROP SCHEMA commun; --', version: 1 }]);
    await expect(m.etape.faire(m.ctx())).rejects.toMatchObject({ code: "module_invalide" });
    expect(m.migre).toEqual([]);
  });
  it("[A-219] le module d'essai fictif a un journal lisible et une première version", () => {
    expect(lireEntrees(DOSSIER_ESSAI).map((e) => e.version)).toEqual([1]);
    expect(verifierMigrationModule(readFileSync(`${DOSSIER_ESSAI}/0000_essai.sql`, "utf8"), "essai")).toEqual([]);
  });
});

describe("migrations d'un module : rester dans a_<code>", () => {
  const pieges = [
    "SET search_path = commun, public;",
    "SET LOCAL search_path TO public;",
    "SELECT set_config('search_path', 'public', false);",
    "CREATE TABLE commun.vole (id int);",
    'CREATE TABLE "public"."vole" (id int);',
    "CREATE TABLE trace.vole (id int);",
    "ALTER ROLE cli_aaaaaaaaaaaa_app SUPERUSER;",
    "ALTER USER cli_aaaaaaaaaaaa_app PASSWORD 'x';",
    "CREATE ROLE intrus LOGIN;",
    "CREATE SCHEMA autre;",
    "ALTER TABLE essai_t SET SCHEMA public;",
    "SET ROLE provisionneur;",
    "RESET ALL;",
    "GRANT ALL ON ALL TABLES IN SCHEMA a_essai TO PUBLIC;",
    "DO $$ BEGIN EXECUTE 'DROP SCHEMA commun CASCADE'; END $$;",
    "COPY essai_t FROM PROGRAM 'id';",
    "SELECT pg_read_file('/etc/passwd');",
    "DROP SCHEMA commun CASCADE;",
  ];
  for (const sql of pieges) {
    it(`[A-219] @isolation une migration de module qui sort de son schéma est refusée : ${sql.slice(0, 40)}`, () => {
      expect(verifierMigrationModule(sql, "essai").length).toBeGreaterThan(0);
    });
  }
  it("[A-219] @isolation un nom de schéma de module hors a_<code> simple est refusé", () => {
    expect(() => verifierMigrationModule("SELECT 1;", "Essai; DROP")).toThrow();
  });
});
