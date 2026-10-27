import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyserSql, empreintesFonctions, gardeMigrations, verifierDossier } from "./garde-migrations.ts";

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

  it("[A-233] B6 : la garde découpe comme drizzle sur --> statement-breakpoint et analyse chaque morceau (N1, N1b, N1c)", () => {
    expect(analyser("CREATE TABLE u(id int);\n--> statement-breakpoint DROP TABLE t;")).toEqual(["m.sql:1: instruction interdite : DROP"]);
    expect(analyser("CREATE TABLE u(id int); -- x --> statement-breakpoint TRUNCATE t;")).toEqual(["m.sql:1: instruction interdite : TRUNCATE"]);
    expect(analyser("SELECT E'\\\\';--> statement-breakpointDROP TABLE t;")).toEqual(["m.sql:1: instruction interdite : DROP"]);
    // Le numéro de ligne part du début du morceau ; un morceau vide est ignoré.
    expect(analyser("CREATE TABLE u(id int);\n--> statement-breakpoint\n\nDROP TABLE t;\n--> statement-breakpoint\n")).toEqual(["m.sql:3: instruction interdite : DROP"]);
  });

  it("[A-233] B7 : tout SET, set_config, ALTER DATABASE/ROLE … SET sont refusés (N2, N2b, N2d)", () => {
    const sql = "SET standard_conforming_strings = off;\n--> statement-breakpoint\nSELECT '\\''; DROP TABLE t; --';";
    expect(analyser(sql)).toContain("m.sql:1: instruction interdite : SET");
    expect(analyser("SELECT set_config('standard_conforming_strings','off',false);")).toEqual(["m.sql:1: instruction interdite : set_config"]);
    expect(analyser("SELECT pg_catalog.SET_CONFIG('backslash_quote','on',false);")).toEqual(["m.sql:1: instruction interdite : set_config"]);
    expect(analyser("ALTER DATABASE essai SET standard_conforming_strings = off;")).toEqual(["m.sql:1: instruction interdite : ALTER DATABASE SET"]);
    expect(analyser("ALTER ROLE console_app SET escape_string_warning = off;")).toEqual(["m.sql:1: instruction interdite : ALTER ROLE SET"]);
    expect(analyser("SET search_path = x;")).toEqual(["m.sql:1: instruction interdite : SET"]);
  });

  it("[A-233] B9 : tout accès à pg_settings est refusé, UPDATE, ONLY, schéma, alias (R1, R2)", () => {
    const refus = ["m.sql:1: instruction interdite : pg_settings"];
    expect(analyser("UPDATE pg_settings SET setting = 'off' WHERE name = 'standard_conforming_strings';")).toEqual(refus);
    expect(analyser("UPDATE ONLY pg_catalog.pg_settings AS s SET setting = 'GBK' WHERE s.name = 'client_encoding';")).toEqual(refus);
    expect(analyser("UPDATE \"pg_settings\" SET setting = 'GBK' WHERE name = 'client_encoding';")).toEqual(refus);
    expect(analyser("CREATE VIEW v AS SELECT * FROM pg_catalog.pg_settings;")).toEqual(refus);
    expect(analyser("UPDATE pg_settings SET setting = 'GBK' WHERE name = 'client_encoding';\n--> statement-breakpoint\nSELECT E'\u20ac\\'; DROP TABLE t; --';")).toEqual(refus);
    expect(analyser("SELECT * FROM pg_stat_activity;")).toEqual([]);
  });

  it("[A-233] B10 : COMMIT et ROLLBACK sont refusés, le lot drizzle tient dans une seule transaction (T1, T2)", () => {
    const refus = ["m.sql:1: instruction interdite : COMMIT/ROLLBACK"];
    expect(analyser("ROLLBACK;")).toEqual(refus);
    expect(analyser("COMMIT;")).toEqual(refus);
    expect(analyser("CREATE TABLE u(id int);\nCOMMIT;\nCREATE TABLE u(id int);").join("\n")).toContain("COMMIT/ROLLBACK");
    expect(analyser("ROLLBACK; CREATE TABLE w(id int);")).toEqual(refus);
  });

  it("[A-233] B8 : ALTER TYPE … RENAME VALUE et ALTER DOMAIN … DROP CONSTRAINT sont refusés (N3, N4)", () => {
    expect(analyser("ALTER TYPE e RENAME VALUE 'a' TO 'z';")).toEqual(["m.sql:1: instruction interdite : RENAME"]);
    expect(analyser("ALTER DOMAIN d DROP CONSTRAINT pos;")).toEqual(["m.sql:1: instruction interdite : DROP"]);
    expect(analyser("ALTER DOMAIN d ADD CONSTRAINT pos CHECK (VALUE > 0);\nALTER DOMAIN d SET DEFAULT 1;")).toEqual([]);
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

// Fonctions permises (A-233) : liste fermée, une entrée = un fichier, un nom de fonction et l'empreinte SHA-256 de son texte.
const FONCTION = [
  "CREATE FUNCTION public.audit_exemple(p_valeur text) RETURNS text",
  "LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp",
  "AS $$ SELECT p_valeur $$",
].join("\n");
const sha = (texte: string) => createHash("sha256").update(texte, "utf8").digest("hex");
const entree = (texte = FONCTION, surcharge: Record<string, string> = {}) => ({ fichier: "0001_fonctions.sql", nom: "audit_exemple", empreinte: sha(texte), adr: "0041", ...surcharge });
const FICHIER = "apps/api/drizzle/0001_fonctions.sql";
const analyserFichier = (sql: string, fonctions: ReturnType<typeof entree>[]) => analyserSql(FICHIER, sql, fonctions);
const refus = (ligne: number, etiquette: string) => `${FICHIER}:${ligne}: instruction interdite : ${etiquette}`;

describe("fonctions permises dans les migrations", () => {
  it("[A-233] une fonction absente de la liste fermée est refusée", () => {
    expect(analyserFichier(`${FONCTION};`, [])).toEqual([refus(1, "CREATE FUNCTION"), refus(1, "SET")]);
    // Listée sous un autre fichier ou un autre nom : refusée aussi.
    expect(analyserFichier(`${FONCTION};`, [entree(FONCTION, { fichier: "0002_autre.sql" })]).length).toBeGreaterThan(0);
    expect(analyserFichier(`${FONCTION};`, [entree(FONCTION, { nom: "autre_nom" })]).length).toBeGreaterThan(0);
  });

  it("[A-233] une fonction listée au texte identique est acceptée, fin de ligne CRLF comprise", () => {
    expect(analyserFichier(`${FONCTION};\n`, [entree()])).toEqual([]);
    expect(analyserFichier(`${FONCTION.replace(/\n/g, "\r\n")};\r\n`, [entree()])).toEqual([]);
    // Après des caractères accentués : les positions de libpg-query sont en octets.
    expect(analyserFichier(`COMMENT ON TABLE é IS 'éé';\nSELECT 1;\n${FONCTION};\n`, [entree()])).toEqual([]);
    expect(analyserFichier(`CREATE TABLE é (id int);\n--> statement-breakpoint\n${FONCTION};\n`, [entree()])).toEqual([]);
  });

  it("[A-233] une fonction listée dont le texte a changé d'un caractère est refusée", () => {
    for (const modifie of [FONCTION.replace("SELECT p_valeur", "SELECT  p_valeur"), FONCTION.replace("SELECT", "select"), FONCTION.replace("audit_exemple(", "audit_exemple (")]) {
      expect(analyserFichier(`${modifie};`, [entree()]).join("\n"), modifie).toContain("CREATE FUNCTION");
    }
    expect(analyserFichier(`${FONCTION};`, [entree()])).toEqual([]);
  });

  it("[A-233] SECURITY DEFINER sans SET search_path est refusé même listé", () => {
    const base = "CREATE FUNCTION public.audit_exemple(p_valeur text) RETURNS text LANGUAGE sql SECURITY DEFINER";
    for (const reglage of ["", " SET search_path FROM CURRENT", " SET work_mem = '1MB'"]) {
      const texte = `${base}${reglage} AS $$ SELECT p_valeur $$`;
      expect(analyserFichier(`${texte};`, [entree(texte)]), reglage).toEqual([refus(1, "SECURITY DEFINER sans search_path")]);
    }
  });

  it("[A-233] CREATE PROCEDURE et DO restent refusés, et la liste ne lève que les étiquettes de SA fonction", () => {
    const procedure = "CREATE PROCEDURE public.audit_exemple() LANGUAGE sql AS $$ SELECT 1 $$";
    expect(analyserFichier(`${procedure};`, [entree(procedure)]).join("\n")).toContain("CREATE FUNCTION");
    expect(analyserFichier("DO $$ BEGIN PERFORM 1; END $$;", [entree()])).toEqual([refus(1, "DO")]);
    const suite = `${FONCTION};\nCALL public.audit_exemple();\nSELECT set_config('a','b',false);\nSET search_path = x;`;
    expect(analyserFichier(suite, [entree()])).toEqual([refus(4, "CALL"), refus(5, "set_config"), refus(6, "SET")]);
    // Une seconde fonction, non listée, reste refusée.
    const deux = `${FONCTION};\n${FONCTION.replace("audit_exemple", "autre")};`;
    expect(analyserFichier(deux, [entree()])).toEqual([refus(4, "CREATE FUNCTION"), refus(4, "SET")]);
  });

  it("[A-233] une entrée de la liste sans instruction correspondante est signalée", () => {
    const racine = mkdtempSync(join(tmpdir(), "garde-fn-"));
    const dossier = join(racine, "apps/api/drizzle");
    mkdirSync(join(dossier, "meta"), { recursive: true });
    writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1, tag: "0001_fonctions", breakpoints: true }] }));
    writeFileSync(join(dossier, "0001_fonctions.sql"), `${FONCTION};\n`);
    expect(gardeMigrations(racine, [entree()])).toEqual([]);
    const morte = entree(FONCTION, { nom: "fonction_morte" });
    expect(gardeMigrations(racine, [entree(), morte])).toEqual(["scripts/garde-migrations-fonctions.json : entrée sans instruction correspondante : 0001_fonctions.sql fonction_morte"]);
    // Texte modifié après le calcul de l'empreinte : la fonction est refusée et l'entrée est morte.
    writeFileSync(join(dossier, "0001_fonctions.sql"), `${FONCTION.replace("SELECT", "select")};\n`);
    const erreurs = gardeMigrations(racine, [entree()]).join("\n");
    expect(erreurs).toContain("CREATE FUNCTION");
    expect(erreurs).toContain("entrée sans instruction correspondante");
  });

  it("[A-233] les dates when du journal des migrations croissent strictement", () => {
    const racine = mkdtempSync(join(tmpdir(), "garde-when-"));
    const dossier = join(racine, "apps/api/drizzle");
    mkdirSync(join(dossier, "meta"), { recursive: true });
    writeFileSync(join(dossier, "0000_a.sql"), "CREATE TABLE a (id int);\n");
    writeFileSync(join(dossier, "0001_b.sql"), "CREATE TABLE b (id int);\n");
    const journal = (...whens: unknown[]) =>
      writeFileSync(join(dossier, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: whens.map((when, idx) => ({ idx, version: "7", when, tag: idx ? "0001_b" : "0000_a", breakpoints: true })) }));
    journal(1000, 2000);
    expect(verifierDossier(dossier)).toEqual([]);
    for (const [premier, second] of [[2000, 1000], [1000, 1000], [1000, "2000"], [1000, null]]) {
      journal(premier, second);
      expect(verifierDossier(dossier, racine).join("\n").replaceAll("\\", "/"), `${premier} ${second}`).toContain("apps/api/drizzle/meta/_journal.json : dates when non strictement croissantes");
    }
  });

  it("[A-233] --empreintes donne le nom et l'empreinte de chaque fonction du fichier", () => {
    expect(empreintesFonctions(`CREATE TABLE a (id int);\n--> statement-breakpoint\n${FONCTION};\n`)).toEqual([{ nom: "audit_exemple", empreinte: sha(FONCTION) }]);
    expect(empreintesFonctions(`${FONCTION.replace(/\n/g, "\r\n")};`)).toEqual([{ nom: "audit_exemple", empreinte: sha(FONCTION) }]);
  });

  it("[A-233] la liste réelle est fermée : forme vérifiée, vide tant qu'aucune fonction n'est relue", () => {
    const liste: { fonctions: Record<string, string>[] } = JSON.parse(readFileSync(fileURLToPath(new URL("./garde-migrations-fonctions.json", import.meta.url)), "utf8"));
    expect(Object.keys(liste)).toEqual(["fonctions"]);
    for (const f of liste.fonctions) expect(f["empreinte"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Correctifs de la relecture sécurité de la PR 93.
describe("fonctions permises : durcissement", () => {
  const definer = (reglages: string, corps = "AS $$ SELECT p_valeur $$") => `CREATE FUNCTION public.audit_exemple(p_valeur text) RETURNS text LANGUAGE sql SECURITY DEFINER ${reglages} ${corps}`;
  const SEC = refus(1, "SECURITY DEFINER sans search_path");

  it("[A-233] ALTER FUNCTION (SECURITY DEFINER, OWNER TO, SET, RESET) est refusé, listé ou non", () => {
    for (const sql of [
      "ALTER FUNCTION public.f(text) SECURITY DEFINER;",
      "ALTER FUNCTION public.f(text) OWNER TO console_proprietaire;",
      "ALTER FUNCTION public.f(text) SET search_path = public;",
      "ALTER FUNCTION public.f(text) RESET ALL;",
      "ALTER PROCEDURE public.p() SECURITY DEFINER;",
      "ALTER ROUTINE public.f(text) SECURITY DEFINER;",
    ]) {
      expect(analyserFichier(sql, [entree(FONCTION)]).length, sql).toBeGreaterThan(0);
      expect(analyserFichier(sql, []).length, sql).toBeGreaterThan(0);
    }
    expect(analyserFichier("ALTER FUNCTION public.f(text) SECURITY DEFINER;", [])[0]).toContain("ALTER FUNCTION");
    expect(analyserFichier("ALTER FUNCTION public.f(text) OWNER TO console_proprietaire;", [])[0]).toContain("ALTER FUNCTION");
  });

  it("[A-233] SECURITY DEFINER exige un seul SET search_path = pg_catalog, pg_temp, même listé", () => {
    const mauvais = [
      "SET search_path = public",
      "SET search_path = pg_catalog",
      "SET search_path = pg_temp, pg_catalog",
      "SET search_path = pg_catalog, pg_temp, public",
      "SET search_path = pg_catalog SET search_path FROM CURRENT",
      "SET search_path = pg_catalog, pg_temp SET search_path = pg_catalog, pg_temp",
      "SET search_path = pg_catalog, pg_temp SET search_path TO DEFAULT",
      "SET search_path TO DEFAULT",
      'SET search_path = pg_catalog, pg_temp SET "SEARCH_PATH" = public',
      'SET search_path = pg_catalog, pg_temp SET "Search_Path" FROM CURRENT',
      'SET "SEARCH_PATH" = pg_catalog, pg_temp SET search_path = public',
      "SET SEARCH_PATH = pg_catalog, pg_temp SET Search_Path = pg_catalog, pg_temp",
    ];
    for (const reglage of mauvais) {
      const texte = definer(reglage);
      expect(analyserFichier(`${texte};`, [entree(texte)]), reglage).toEqual([SEC]);
    }
    const bon = definer("SET search_path = pg_catalog, pg_temp");
    expect(analyserFichier(`${bon};`, [entree(bon)])).toEqual([]);
    // Casse et guillemets : PostgreSQL ramène le nom à la forme officielle, un réglage unique en majuscules reste accepté.
    for (const reglage of ["SET SEARCH_PATH = pg_catalog, pg_temp", 'SET "search_path" = pg_catalog, pg_temp']) {
      const texte = definer(reglage);
      expect(analyserFichier(`${texte};`, [entree(texte)]), reglage).toEqual([]);
    }
    const autreReglage = definer("SET search_path = pg_catalog, pg_temp SET work_mem = '1MB'");
    expect(analyserFichier(`${autreReglage};`, [entree(autreReglage)])).toEqual([]);
  });

  it("[A-233] une fonction listée qui contient set_config ou pg_settings reste refusée", () => {
    const base = "CREATE FUNCTION public.audit_exemple(p_valeur text";
    const cas: [string, string][] = [
      ["corps BEGIN ATOMIC", `${base}) RETURNS text LANGUAGE sql BEGIN ATOMIC SELECT set_config('a', 'b', false); END`],
      ["valeur par défaut de paramètre", `${base} DEFAULT set_config('a', 'b', false)) RETURNS text LANGUAGE sql AS $$ SELECT 1 $$`],
      ["pg_settings dans BEGIN ATOMIC", `${base}) RETURNS text LANGUAGE sql BEGIN ATOMIC SELECT name::text FROM pg_catalog.pg_settings; END`],
      ["set_config qualifié", `${base}) RETURNS text LANGUAGE sql BEGIN ATOMIC SELECT pg_catalog.set_config('a', 'b', true); END`],
    ];
    for (const [nomCas, texte] of cas) {
      const erreurs = analyserFichier(`${texte};`, [entree(texte)]);
      expect(erreurs.length, nomCas).toBeGreaterThan(0);
      expect(erreurs.join("\n"), nomCas).not.toContain("CREATE FUNCTION");
    }
  });
});
