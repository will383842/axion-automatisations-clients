import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as cli from "./index.ts";

// Modèle des bases des clients (T2-32, ADR 0046) : structure lue dans le schéma Drizzle et dans le SQL généré. Aucune base n'est ouverte ici.
const racine = (chemin: string) => fileURLToPath(new URL(`../../../../../${chemin}`, import.meta.url));
const tables: PgTable[] = [cli.etablissements, cli.entreprises, cli.personnes, cli.listesProspects, cli.listesProspectsPersonnes, cli.exclusions, cli.indexFichiers, cli.evenements, cli.versionStructure];
const config = (nom: string) => {
  const t = tables.map((x) => getTableConfig(x)).find((c) => c.name === nom);
  if (!t) throw new Error(`table ${nom} absente du schéma cli`);
  return t;
};
const sqlDe = (dossier: string) => readdirSync(racine(dossier)).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(racine(`${dossier}/${f}`), "utf8")).join("\n");

describe("modèle des bases des clients", () => {
  it("[A-207] une base créée depuis modele_v1 a les schémas commun et trace et la table version_structure", () => {
    const sql = sqlDe("apps/api/drizzle-cli");
    expect(sql).toContain('CREATE SCHEMA "commun"');
    expect(sql).toContain('CREATE SCHEMA "trace"');
    expect(config("version_structure").schema ?? "public").toBe("public");
    for (const nom of ["personnes", "entreprises", "etablissements", "listes_prospects", "listes_prospects_personnes", "exclusions", "index_fichiers"]) expect(config(nom).schema, nom).toBe("commun");
    expect(config("evenements").schema).toBe("trace");
    // Les schémas a_<code> viennent des modules (T2-35), pas du modèle.
    expect(sql).not.toMatch(/CREATE SCHEMA "a_/);
  });

  it("[A-208] les listes de prospects vivent dans commun ; aucune table de ce nom n'existe dans console ni moteur", () => {
    expect(config("listes_prospects").schema).toBe("commun");
    expect(sqlDe("apps/api/drizzle")).not.toContain("listes_prospects");
    expect(sqlDe("apps/executeur/drizzle")).not.toContain("listes_prospects");
  });

  it("[A-225] chaque base porte sa version de structure", () => {
    const colonnes = config("version_structure").columns.map((c) => c.name);
    expect(colonnes).toEqual(expect.arrayContaining(["version", "appliquee_le", "empreinte"]));
    expect(config("version_structure").columns.find((c) => c.name === "version")?.primary).toBe(true);
  });

  it("[B-173] une personne sans établissement est refusée : etablissement_id est NOT NULL sur les trois tables liées", () => {
    for (const nom of ["personnes", "listes_prospects", "index_fichiers"]) {
      const c = config(nom).columns.find((x) => x.name === "etablissement_id");
      expect(c?.notNull, nom).toBe(true);
    }
  });

  it("[A-207] e-mails et téléphones : colonnes bytea <champ>_chiffre et <champ>_empreinte, jamais en clair", () => {
    const p = config("personnes").columns;
    for (const champ of ["courriel", "telephone"]) {
      expect(p.find((c) => c.name === `${champ}_chiffre`)?.getSQLType()).toBe("bytea");
      expect(p.find((c) => c.name === `${champ}_empreinte`)?.getSQLType()).toBe("bytea");
      expect(p.some((c) => c.name === champ)).toBe(false);
    }
    expect(config("index_fichiers").columns.map((c) => c.name)).not.toContain("contenu");
  });

  it("[A-207] la trace est en ajout seul : un déclencheur refuse UPDATE et DELETE, et le propriétaire garde la table", () => {
    const sql = sqlDe("apps/api/drizzle-cli");
    expect(sql).toMatch(/CREATE TRIGGER \w+ BEFORE UPDATE OR DELETE ON "trace"\."evenements"/);
    // Chaque fonction créée a SON search_path figé et SON REVOKE ALL ... FROM PUBLIC : en retirer un seul rougit l'essai.
    const fonctions = [...sql.matchAll(/CREATE FUNCTION ([\w."]+)\(\)([\s\S]*?)\$fonction\$;/g)];
    expect(fonctions.length).toBeGreaterThan(0);
    for (const [, nom, corps] of fonctions) {
      expect(corps, `${nom} : search_path`).toContain("SET search_path = pg_catalog, pg_temp");
      expect(sql, `${nom} : REVOKE`).toContain(`REVOKE ALL ON FUNCTION ${nom}() FROM PUBLIC`);
    }
    expect(sql).toMatch(/IN \('import', 'modification', 'export'\)/);
  });

  it("[C-034] prénom et type de contenu sont bornés, les empreintes ont 32 octets, retire_le existe", () => {
    const sql = sqlDe("apps/api/drizzle-cli");
    for (const c of ["prenom", "type_contenu"]) expect(sql, c).toContain(`CHECK (char_length("${c}") <= 500)`);
    for (const c of ["courriel_empreinte", "telephone_empreinte", "empreinte"]) expect(sql, c).toContain(`octet_length("${c}") = 32`);
    expect(config("listes_prospects_personnes").columns.map((c) => c.name)).toContain("retire_le");
  });

  it("[A-212] les droits : aucun DELETE accordé, exclusions sans UPDATE", () => {
    const source = readFileSync(racine("apps/api/src/donnees/migrer-base.ts"), "utf8");
    expect(source).not.toMatch(/GRANT[^`]*DELETE/);
    expect(source).toContain("REVOKE UPDATE ON commun.exclusions FROM");
  });

  it("[B-348] le modèle ne contient aucune ligne : aucune instruction INSERT dans les migrations", () => {
    expect(sqlDe("apps/api/drizzle-cli")).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});
