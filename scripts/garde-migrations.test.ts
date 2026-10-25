import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyserSql, gardeMigrations } from "./garde-migrations.ts";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/migrations", import.meta.url));
const analyser = (sql: string) => analyserSql("m.sql", sql);

describe("garde des migrations", () => {
  it("[A-233] garde-migrations refuse DROP TABLE", () => {
    expect(analyser("DROP TABLE atelier;")).toEqual(["m.sql:1: instruction interdite : DROP"]);
  });

  it("[A-233] garde-migrations refuse RENAME COLUMN", () => {
    expect(analyser("ALTER TABLE a\nRENAME COLUMN x TO y;")).toEqual(["m.sql:1: instruction interdite : RENAME"]);
  });

  it("[A-233] garde-migrations refuse ALTER COLUMN TYPE", () => {
    expect(analyser("ALTER TABLE a ALTER COLUMN x TYPE integer;")).toEqual(["m.sql:1: instruction interdite : ALTER … TYPE"]);
  });

  it("[A-233] garde-migrations accepte ADD COLUMN et CREATE TABLE", () => {
    expect(analyser("CREATE TABLE a (id uuid);\nALTER TABLE a ADD COLUMN type text;\nCREATE TYPE couleur AS ENUM ('a');\nALTER TYPE couleur ADD VALUE 'b';")).toEqual([]);
  });

  it("[A-233] attaque : minuscules, retours à la ligne, DROP COLUMN, DROP INDEX et TRUNCATE sont attrapés", () => {
    for (const f of ["ko-drop-colonne", "ko-drop-table", "ko-rename-colonne", "ko-truncate"]) {
      expect(analyser(lireFixture(f)).length, f).toBeGreaterThan(0);
    }
    expect(analyser(lireFixture("ko-drop-colonne"))[0]).toBe("m.sql:1: instruction interdite : DROP");
    const types = analyser(lireFixture("ko-alter-type"));
    expect(types.map((e) => e.split(":")[1])).toEqual(["1", "2", "3"]);
  });

  it("[A-233] attaque : un DROP dans un bloc DO $$ … $$ ou un SQL dynamique EXECUTE est attrapé", () => {
    expect(analyser(lireFixture("ko-bloc-do"))).toEqual(["m.sql:1: instruction interdite : DO"]);
    expect(analyser(lireFixture("ko-sql-dynamique"))).toEqual(["m.sql:1: instruction interdite : DO"]);
  });

  it("[A-233] attaque : l'antislash d'une chaîne normale ne cache pas un DROP, celui d'une chaîne E'…' oui", () => {
    expect(analyser(lireFixture("ko-antislash"))).toEqual(["m.sql:1: instruction interdite : DROP"]);
    expect(analyser(lireFixture("ok-chaine-e"))).toEqual([]);
  });

  it("[A-233] attaque : un commentaire ou une chaîne jamais fermés font échouer la garde", () => {
    for (const f of ["ko-commentaire-ouvert", "ko-chaine-ouverte"]) {
      const erreurs = analyser(lireFixture(f));
      expect(erreurs.length, f).toBe(1);
      expect(erreurs[0], f).toMatch(/^m\.sql: SQL illisible : /);
    }
  });

  it("[A-233] pas de faux refus : commentaires, chaînes et colonne nommée type", () => {
    expect(analyser(lireFixture("ok-additive"))).toEqual([]);
  });

  it("[A-233] la garde analyse les fichiers du journal ; un .SQL en sous-dossier ou un lien symbolique est refusé", () => {
    const racine = mkdtempSync(join(tmpdir(), "garde-mig-"));
    const dossier = join(racine, "apps/api/drizzle");
    mkdirSync(join(dossier, "meta"), { recursive: true });
    writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 0, tag: "0000_a", breakpoints: true }] }));
    writeFileSync(join(dossier, "0000_a.sql"), "CREATE TABLE a (id int);\n");
    expect(gardeMigrations(racine)).toEqual([]);
    cpSync(FIXTURES, join(dossier, "fix"), { recursive: true });
    expect(gardeMigrations(racine).some((e) => e.startsWith("apps/api/drizzle/fix/imbrique/profond/ko-majuscule.SQL : fichier SQL absent du journal"))).toBe(true);
    symlinkSync("/nonexistent", join(dossier, "0001_lien.sql"));
    expect(gardeMigrations(racine).join("\n")).toContain("lien symbolique interdit");
  });

  it("[A-233] sonde 24 : DO avec corps entre apostrophes (simples ou E'…') est refusé", () => {
    expect(analyser("DO 'BEGIN DROP TABLE t; END';")).toEqual(["m.sql:1: instruction interdite : DO"]);
    expect(analyser("DO E'BEGIN DROP TABLE t; END';")).toEqual(["m.sql:1: instruction interdite : DO"]);
  });

  it("[A-233] sonde 25 : CREATE FUNCTION ou PROCEDURE (corps entre apostrophes) et CALL sont refusés", () => {
    expect(analyser("CREATE FUNCTION f() RETURNS void LANGUAGE sql AS 'DROP TABLE t';\nSELECT f();")).toEqual(["m.sql:1: instruction interdite : CREATE FUNCTION"]);
    expect(analyser("CREATE PROCEDURE p() LANGUAGE sql AS 'TRUNCATE t';\nCALL p();")).toEqual(["m.sql:1: instruction interdite : CREATE FUNCTION", "m.sql:2: instruction interdite : CALL"]);
  });

  it("[A-233] sonde 26 : x$e'\\' ne désynchronise pas la lecture des chaînes", () => {
    expect(analyser("CREATE DOMAIN x$e AS text;\nSELECT x$e'\\'; DROP TABLE t; --';")).toEqual(["m.sql:2: instruction interdite : DROP"]);
  });

  it("[A-233] sonde 27 et 28 : ALTER \"c\" TYPE et ALTER ATTRIBUTE … TYPE sont refusés", () => {
    expect(analyser('ALTER TABLE t ALTER "c" TYPE bigint;')).toEqual(["m.sql:1: instruction interdite : ALTER … TYPE"]);
    expect(analyser("ALTER TYPE comp ALTER ATTRIBUTE a TYPE bigint;")).toEqual(["m.sql:1: instruction interdite : ALTER … TYPE"]);
  });

  it("[A-233] sonde 34 : déclencheur, GRANT EXECUTE, SET DEFAULT 'x' et COMMENT $$ ne sont pas des faux refus", () => {
    const sql = [
      "CREATE TRIGGER t_avant BEFORE INSERT ON atelier FOR EACH ROW EXECUTE FUNCTION f();",
      "GRANT EXECUTE ON FUNCTION f() TO console_app;",
      "ALTER TABLE atelier ALTER COLUMN type SET DEFAULT 'x';",
      "COMMENT ON TABLE atelier IS $$c'est$$;",
    ].join("\n");
    expect(analyser(sql)).toEqual([]);
  });

  it("[A-233] EXECUTE d'une requête préparée, SET SCHEMA et DROP caché dans CREATE SCHEMA sont refusés", () => {
    expect(analyser("PREPARE p AS SELECT 1;\nEXECUTE p;")).toEqual(["m.sql:2: instruction interdite : EXECUTE"]);
    expect(analyser("ALTER TABLE t SET SCHEMA x;")).toEqual(["m.sql:1: instruction interdite : SET SCHEMA"]);
    expect(analyser("CREATE SCHEMA s CREATE TABLE a (id int);\nDROP SCHEMA s;")).toEqual(["m.sql:2: instruction interdite : DROP"]);
  });

  it("[A-233] sonde 30 : le journal drizzle est lu, un tag avec / ou .. est refusé, le fichier désigné doit exister", () => {
    const racine = mkdtempSync(join(tmpdir(), "garde-jr-"));
    const dossier = join(racine, "apps/api/drizzle");
    mkdirSync(join(dossier, "meta"), { recursive: true });
    mkdirSync(join(racine, "apps/api/hors"), { recursive: true });
    writeFileSync(join(racine, "apps/api/hors/0000_cache.sql"), "DROP TABLE t;\n");
    const journal = (...tags: string[]) => writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: tags.map((tag, idx) => ({ idx, version: "7", when: idx, tag, breakpoints: true })) }));
    for (const tag of ["../hors/0000_cache", "0000_a/../b", "0000_A", "a", "0000_x.sql", "0000_é"]) {
      journal(tag);
      expect(gardeMigrations(racine).join("\n"), tag).toContain("tag de journal invalide");
    }
    journal("0000_absente");
    expect(gardeMigrations(racine).join("\n")).toContain("0000_absente.sql : fichier du journal introuvable");
    writeFileSync(join(dossier, "0000_ok.sql"), "CREATE TABLE a (id int);\n");
    writeFileSync(join(dossier, "0001_ko.sql"), "DROP TABLE a;\n");
    journal("0000_ok");
    expect(gardeMigrations(racine).join("\n")).toContain("0001_ko.sql : fichier SQL absent du journal");
    journal("0000_ok", "0001_ko");
    expect(gardeMigrations(racine)).toEqual(["apps/api/drizzle/0001_ko.sql:1: instruction interdite : DROP"]);
    writeFileSync(join(dossier, "meta/_journal.json"), "pas du json");
    expect(gardeMigrations(racine).join("\n")).toContain("journal illisible");
  });

  it("[A-233] des fichiers SQL sans journal sont refusés", () => {
    const racine = mkdtempSync(join(tmpdir(), "garde-sj-"));
    mkdirSync(join(racine, "apps/api/drizzle"), { recursive: true });
    writeFileSync(join(racine, "apps/api/drizzle/0000_a.sql"), "SELECT 1;\n");
    expect(gardeMigrations(racine).join("\n")).toContain("journal absent");
  });

  it("[A-233] le dépôt réel ne contient aucune migration interdite", () => {
    expect(gardeMigrations(fileURLToPath(new URL("..", import.meta.url)))).toEqual([]);
  });
});

function lireFixture(nom: string): string {
  return readFileSync(`${FIXTURES}/${nom}.sql`, "utf8");
}
