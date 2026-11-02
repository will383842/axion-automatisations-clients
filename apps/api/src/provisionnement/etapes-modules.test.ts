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

// Contournements du filtre textuel relevés par l'audit (B1) : un essai par contournement. Le filtre n'est qu'une première barrière (la vraie : le rôle de migration du module).
describe("migrations d'un module : contournements du filtre textuel", () => {
  const contournements: [string, string][] = [
    ["commentaire qui coupe un mot composé", "ALTER/**/ROLE cli_aaaaaaaaaaaa_app SUPERUSER;"],
    ["commentaire de ligne qui coupe un mot composé", "SET --\n ROLE provisionneur;"],
    ["commentaire autour du point d'un schéma protégé", "CREATE TABLE commun /**/ . /**/ vole (id int);"],
    ["identifiant en échappement Unicode", 'CREATE TABLE U&"\\0063ommun"."vole" (id int);'],
    ["COMMIT qui valide avant le comptage", "CREATE TABLE t (id int); COMMIT; CREATE TABLE u (id int);"],
    ["END, synonyme de COMMIT", "CREATE TABLE t (id int); END;"],
    ["ROLLBACK", "CREATE TABLE t (id int); ROLLBACK;"],
    ["ABORT, synonyme de ROLLBACK", "ABORT;"],
    ["BEGIN", "BEGIN; CREATE TABLE t (id int);"],
    ["START TRANSACTION", "START TRANSACTION;"],
    ["SAVEPOINT", "SAVEPOINT s;"],
    ["SET ROLE", "SET ROLE cli_aaaaaaaaaaaa_proprietaire;"],
    ["RESET ROLE", "RESET ROLE;"],
    ["DISCARD ALL", "DISCARD ALL;"],
    ["DELETE", "DELETE FROM essai_notes;"],
    ["TRUNCATE", "TRUNCATE essai_notes;"],
    ["UPDATE", "UPDATE essai_notes SET texte = 'x';"],
    ["DELETE caché dans un WITH", "WITH d AS (DELETE FROM essai_notes RETURNING 1) SELECT 1;"],
    ["INSERT dans commun", "INSERT INTO commun.exclusions (id) VALUES (1);"],
    ["INSERT dans le schéma d'un autre module", "INSERT INTO a_autre.t (id) VALUES (1);"],
    ["DISABLE ROW LEVEL SECURITY", "ALTER TABLE essai_notes DISABLE ROW LEVEL SECURITY;"],
    ["NO FORCE ROW LEVEL SECURITY", "ALTER TABLE essai_notes NO FORCE ROW LEVEL SECURITY;"],
    ["changement de propriétaire", "ALTER TABLE essai_notes OWNER TO provisionneur;"],
    ["ordre hors de la liste blanche", "VACUUM essai_notes;"],
  ];
  for (const [nom, sql] of contournements) {
    it(`[A-219] @isolation contournement refusé : ${nom}`, () => {
      expect(verifierMigrationModule(sql, "essai").length).toBeGreaterThan(0);
    });
  }
  it("[A-219] @isolation un marqueur de commentaire dans une chaîne ne cache pas le reste du texte", () => {
    expect(verifierMigrationModule("SELECT '/*'; COMMIT; SELECT '*/';", "essai").length).toBeGreaterThan(0);
  });
  it("[A-219] une migration ordinaire avec commentaires, chaînes et insertion dans son schéma reste acceptée", () => {
    const sql = "-- table de notes\nCREATE TABLE essai_t (id int, texte text DEFAULT '--/*'); /* fin */\nINSERT INTO essai_t (id) VALUES (1);\nINSERT INTO a_essai.essai_t (id) VALUES (2);";
    expect(verifierMigrationModule(sql, "essai")).toEqual([]);
  });
});

// Audit B1/M1 : le texte caché dans un corps de fonction ou une chaîne $…$ est contrôlé comme le reste, commentaires retirés. Une migration de module ne détruit jamais de données.
describe("migrations d'un module : charges de l'audit (M1)", () => {
  const charges: [string, string][] = [
    ["R1 : RESET ROLE et ALTER ROLE cachés dans un corps de fonction", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ RESET/**/ROLE; ALTER/**/ROLE cli_aaaaaaaaaaaa_app PASSWORD 'connu'; SELECT 1 $f$; CREATE TABLE t (x int DEFAULT f()); INSERT INTO t DEFAULT VALUES;"],
    ["R1-bis : RESET \"role\" entre guillemets", 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ RESET/**/"role"; SELECT 1 $f$; CREATE TABLE t (x int DEFAULT f()); INSERT INTO t DEFAULT VALUES;'],
    ["R2 : schéma commun avec commentaire avant le point", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ SELECT count(*)::int FROM commun/**/.personnes $f$;"],
    ["R4 : DROP TABLE et DELETE FROM dans un corps de fonction", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ DROP/**/TABLE essai_notes; DELETE/**/FROM essai_notes; SELECT 1 $f$;"],
    ["R5 : TRUNCATE et SET SESSION AUTHORIZATION après un -- dans une chaîne", "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $f$ BEGIN PERFORM '--'; TRUNCATE essai_notes; SET/**/SESSION/**/AUTHORIZATION postgres; RETURN 1; END $f$;"],
    ["DROP TABLE seul", "DROP TABLE essai_notes;"],
    ["DROP TABLE avec commentaire entre les mots", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ DROP /* x */ TABLE essai_notes $$;"],
    ["ALTER TABLE … DROP COLUMN", "ALTER TABLE essai_notes DROP COLUMN texte;"],
    ["ALTER TABLE … DROP sans le mot COLUMN", "ALTER TABLE essai_notes DROP texte;"],
    ["DROP COLUMN avec retour à la ligne et commentaire", "ALTER TABLE essai_notes\n  DROP --x\n  COLUMN texte;"],
    ["DROP SCHEMA dans un corps de fonction", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ DROP/**/SCHEMA a_essai CASCADE $f$;"],
    ["TRUNCATE dans un bloc $…$ nommé", "COMMENT ON TABLE essai_notes IS $x$ TRUNCATE/**/essai_notes $x$;"],
    ["CREATE USER", "CREATE USER pirate PASSWORD 'x';"],
    ["ALTER USER caché dans un corps de fonction", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ ALTER/**/USER cli_aaaaaaaaaaaa_app PASSWORD 'x' $f$;"],
    ["SET LOCAL ROLE", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ SET/**/LOCAL/**/ROLE postgres $f$;"],
    ["SET \"role\" entre guillemets", 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ SET "role" TO postgres $f$;'],
    ["commentaire de ligne caché derrière un -- dans une chaîne", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ SELECT '--'; RESET --c\n ROLE $f$;"],
  ];
  for (const [nom, sql] of charges) {
    it(`[A-219] @isolation charge de l'audit refusée : ${nom}`, () => {
      expect(verifierMigrationModule(sql, "essai").length).toBeGreaterThan(0);
    });
  }
  it("[A-219] une migration qui garde ON DELETE CASCADE, DROP CONSTRAINT et un commentaire apostrophé dans un bloc $…$ reste acceptée", () => {
    const sql = "CREATE TABLE essai_t (id int PRIMARY KEY, n int REFERENCES essai_t (id) ON DELETE CASCADE);\nALTER TABLE essai_t DROP CONSTRAINT essai_t_n_fkey;\nALTER TABLE essai_t ALTER COLUMN n DROP NOT NULL;\nCOMMENT ON TABLE essai_t IS $$l'état des notes$$;";
    expect(verifierMigrationModule(sql, "essai")).toEqual([]);
  });
});
