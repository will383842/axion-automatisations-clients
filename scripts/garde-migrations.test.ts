import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(analyser("ALTER TABLE a\nRENAME COLUMN x TO y;")).toEqual(["m.sql:2: instruction interdite : RENAME"]);
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
    expect(analyser(lireFixture("ko-drop-colonne"))[0]).toBe("m.sql:2: instruction interdite : DROP");
    const types = analyser(lireFixture("ko-alter-type"));
    expect(types.map((e) => e.split(":")[1])).toEqual(["1", "2", "3"]);
  });

  it("[A-233] attaque : un DROP dans un bloc DO $$ … $$ ou un SQL dynamique EXECUTE est attrapé", () => {
    expect(analyser(lireFixture("ko-bloc-do"))).toEqual(["m.sql:3: instruction interdite : DROP"]);
    expect(analyser(lireFixture("ko-sql-dynamique"))).toEqual(["m.sql:1: instruction interdite : EXECUTE"]);
  });

  it("[A-233] attaque : l'antislash d'une chaîne normale ne cache pas un DROP, celui d'une chaîne E'…' oui", () => {
    expect(analyser(lireFixture("ko-antislash"))).toEqual(["m.sql:1: instruction interdite : DROP"]);
    expect(analyser(lireFixture("ok-chaine-e"))).toEqual([]);
  });

  it("[A-233] attaque : un commentaire ou une chaîne jamais fermés font échouer la garde", () => {
    expect(analyser(lireFixture("ko-commentaire-ouvert"))).toEqual(["m.sql:1: commentaire non fermé"]);
    expect(analyser(lireFixture("ko-chaine-ouverte"))).toEqual(["m.sql:1: chaîne non fermée"]);
  });

  it("[A-233] pas de faux refus : commentaires, chaînes et colonne nommée type", () => {
    expect(analyser(lireFixture("ok-additive"))).toEqual([]);
  });

  it("[A-233] la garde lit apps/*/drizzle/**/*.sql, sous-dossiers et extension .SQL compris", () => {
    const racine = mkdtempSync(join(tmpdir(), "garde-mig-"));
    mkdirSync(join(racine, "apps/api/drizzle"), { recursive: true });
    writeFileSync(join(racine, "apps/api/drizzle/0001.sql"), "CREATE TABLE a (id int);\n");
    expect(gardeMigrations(racine)).toEqual([]);
    cpSync(FIXTURES, join(racine, "apps/api/drizzle/fix"), { recursive: true });
    const erreurs = gardeMigrations(racine);
    expect(erreurs.some((e) => e.startsWith("apps/api/drizzle/fix/imbrique/profond/ko-majuscule.SQL:1: instruction interdite : DROP"))).toBe(true);
    expect(erreurs.some((e) => e.includes("ok-additive"))).toBe(false);
  });

  it("[A-233] le dépôt réel ne contient aucune migration interdite", () => {
    expect(gardeMigrations(fileURLToPath(new URL("..", import.meta.url)))).toEqual([]);
  });
});

function lireFixture(nom: string): string {
  return readFileSync(`${FIXTURES}/${nom}.sql`, "utf8");
}
