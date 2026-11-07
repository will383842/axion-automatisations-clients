import { readdirSync, readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TABLES_COMMUNES } from "../../../../packages/contrats/src/c5/invariants.ts";
import { analyserSql } from "../../../../scripts/garde-migrations.ts";
import { passagesVersion, preuvesProcedure, versionsAutomatisation } from "../db/schema/catalogue.ts";

// Migration 0027 (T4-27a, ADR 0122) : cycle de vie des versions et preuves de la procédure. Les essais contre PostgreSQL sont dans import.int.test.ts.
const dossier = new URL("../../drizzle/", import.meta.url);
const NOM = "0027_cycle_de_vie_des_versions.sql";
const migration = () => readFileSync(new URL(NOM, dossier), "utf8");
const code = () => migration().replace(/--[^\n]*/g, "");
const lire = (f: string) => JSON.parse(readFileSync(new URL(f, dossier), "utf8")) as Record<string, unknown>;
const checks = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).checks.map((c) => c.name);
const colonnes = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).columns.map((c) => c.name);
const droits = (table: string, role: string) => [...code().matchAll(new RegExp(`GRANT ([A-Z, ]+(?:\\([^)]*\\))?) ON TABLE "public"\\."${table}" TO ${role}`, "g"))].map((m) => m[1] ?? "");

describe("cycle de vie des versions : schéma et migration 0027", () => {
  it("[C-240] la migration 0027 crée preuves_procedure : étape bornée de 1 à 10, une preuve par version, étape et empreinte", () => {
    const cfg = getTableConfig(preuvesProcedure);
    expect(cfg.uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)])).toEqual([["preuves_procedure_version_etape_empreinte_unique", ["version_id", "etape", "empreinte_sha256"]]]);
    expect(checks(preuvesProcedure)).toEqual(expect.arrayContaining(["preuves_procedure_etape_bornee", "preuves_procedure_contenu_sans_client", "preuves_procedure_mesure_etape_7"]));
    const texte = code();
    expect(texte).toContain('CREATE TABLE "preuves_procedure"');
    expect(texte).toMatch(/"preuves_procedure_etape_bornee" CHECK \("preuves_procedure"\."etape" BETWEEN 1 AND 10\)/);
    expect(texte).toMatch(/UNIQUE\("version_id","etape","empreinte_sha256"\)/);
    expect(texte).toMatch(/ON DELETE restrict/);
  });

  it("[C-240] la migration 0027 est additive : ni DROP, ni DELETE, ni TRUNCATE, ni RENAME, ni changement de type, ni CREATE FUNCTION, ni ALTER TYPE", () => {
    expect(analyserSql(NOM, migration())).toEqual([]);
    const t = code();
    expect(t).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(t).not.toMatch(/ALTER\s+COLUMN[^;]*\bTYPE\b|\bALTER\s+TYPE\b/i);
    expect(t).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|UPDATE)\b[^;]*"(preuves_procedure|passages_version)"/i);
    expect(t).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|SECURITY\s+DEFINER|^\s*DO\b/im);
    expect(t).toMatch(/ADD CONSTRAINT "versions_automatisation_modeles_testes_bornes" CHECK[^;]*NOT VALID;/);
    expect(t).toContain('VALIDATE CONSTRAINT "versions_automatisation_modeles_testes_bornes"');
  });

  it("[A-119] preuves_procedure et passages_version sont dans TABLES_COMMUNES, sans tenant_id, RLS activée et forcée, aucun droit pour console_app, console_lecture ni PUBLIC", () => {
    const texte = code();
    for (const [nom, t] of [["preuves_procedure", preuvesProcedure], ["passages_version", passagesVersion]] as const) {
      expect(TABLES_COMMUNES, nom).toContain(`public.${nom}`);
      expect(colonnes(t), nom).not.toContain("tenant_id");
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`REVOKE ALL ON TABLE "public"."${nom}" FROM PUBLIC`);
      expect(droits(nom, "console_app"), nom).toEqual([]);
      expect(droits(nom, "console_lecture"), nom).toEqual([]);
      expect(droits(nom, "PUBLIC"), nom).toEqual([]);
      expect(droits(nom, "console_equipe")[0], nom).toBe("SELECT");
      expect(texte, nom).toContain(`CREATE TRIGGER ${nom}_sans_suppression BEFORE DELETE ON "public"."${nom}" FOR EACH ROW EXECUTE FUNCTION public.catalogue_garde()`);
      expect(texte, nom).toContain(`CREATE TRIGGER ${nom}_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."${nom}" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe()`);
      expect(texte, nom).toMatch(new RegExp(`CREATE POLICY auteur_acteur ON "public"\\."${nom}" AS RESTRICTIVE FOR INSERT TO console_equipe`));
    }
  });

  it("[C-249] passe_le et cree_le ne sont dans aucun GRANT INSERT : l'heure vient du serveur", () => {
    for (const nom of ["preuves_procedure", "passages_version"]) {
      const inserts = droits(nom, "console_equipe").filter((d) => d.startsWith("INSERT"));
      expect(inserts, nom).toHaveLength(1);
      expect(inserts[0], nom).not.toMatch(/"(passe_le|cree_le|id)"/);
    }
    expect(droits("passages_version", "console_equipe")[1]).toContain('"statut_depart"');
    expect(colonnes(passagesVersion)).toContain("passe_le");
    expect(colonnes(preuvesProcedure)).toContain("cree_le");
  });

  it("[B-461] passages_version : une arrivée en depreciee exige fin_annoncee_le", () => {
    expect(checks(passagesVersion)).toContain("passages_version_depreciation_datee");
    expect(code()).toMatch(/"passages_version_depreciation_datee" CHECK \(\("passages_version"\."statut_arrivee" = 'depreciee'\) = \("passages_version"\."fin_annoncee_le" IS NOT NULL\)\)/);
  });

  it("[B-462] passages_version : une arrivée en retiree exige une remplaçante distincte et une date de prévenance", () => {
    expect(checks(passagesVersion)).toEqual(expect.arrayContaining(["passages_version_retrait_complet", "passages_version_remplacante_autre", "passages_version_transition_permise"]));
    const t = code();
    expect(t).toMatch(/"passages_version_retrait_complet" CHECK[^;]*"remplacante_id" IS NOT NULL[^;]*"prevenance_le" IS NOT NULL/);
    expect(t).toMatch(/"passages_version_remplacante_autre" CHECK \("passages_version"\."remplacante_id" IS NULL OR "passages_version"\."remplacante_id" <> "passages_version"\."version_id"\)/);
  });

  it("[C-202] versions_automatisation.modeles_testes est un text[] borné en nombre et en forme, modifiable par console_equipe seulement", () => {
    const c = getTableConfig(versionsAutomatisation).columns.find((x) => x.name === "modeles_testes");
    expect(c?.getSQLType()).toBe("text[]");
    expect(c?.notNull).toBe(false);
    expect(checks(versionsAutomatisation)).toContain("versions_automatisation_modeles_testes_bornes");
    const t = code();
    expect(t).toContain('ALTER TABLE "versions_automatisation" ADD COLUMN "modeles_testes" text[];');
    expect(t).toMatch(/cardinality\("versions_automatisation"\."modeles_testes"\) <= 16/);
    expect(t).toContain('GRANT UPDATE ("modeles_testes") ON TABLE "public"."versions_automatisation" TO console_equipe;');
    expect(t).not.toMatch(/GRANT[^;]*"modeles_testes"[^;]*TO (console_app|console_lecture|PUBLIC)/);
  });

  it("[A-305] passages_version n'admet que les six passages de la machine d'états, la même liste que catalogue_garde (0007), sans réécrire cette fonction", () => {
    const liste = (texte: string) => /\(\('brouillon', 'recette'\)[^;]*?\('depreciee', 'retiree'\)\)/.exec(texte)?.[0];
    const garde = readFileSync(new URL("0007_catalogue.sql", dossier), "utf8");
    expect(liste(code())).toBeDefined();
    expect(liste(code())).toBe(liste(garde));
    expect(code()).not.toMatch(/catalogue_garde\(\)\s*RETURNS|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it("[A-306] une version figée le reste : 0027 n'ouvre que modeles_testes en écriture, la preuve est liée à l'empreinte de l'artefact et la base garde le déclencheur de 0007", () => {
    const t = code();
    const ouverts = [...t.matchAll(/GRANT UPDATE \(([^)]*)\) ON TABLE "public"\."versions_automatisation"/g)].map((m) => m[1]);
    expect(ouverts).toEqual(['"modeles_testes"']);
    expect(t).not.toMatch(/(DISABLE|DROP)\s+TRIGGER|ALTER TABLE "(public"\."|)versions_automatisation" (ENABLE|DISABLE) /);
    expect(getTableConfig(preuvesProcedure).uniqueConstraints[0]?.columns.map((c) => c.name)).toContain("empreinte_sha256");
    expect(getTableConfig(passagesVersion).columns.map((c) => c.name)).toContain("empreinte_sha256");
  });

  it("[LOT4-cycle] journal et instantané : 0027 suit 0026, quand croît, prevId de 0027 = id de 0026, un seul fichier 0027", () => {
    const journal = (lire("meta/_journal.json") as { entries: { idx: number; tag: string; when: number }[] }).entries;
    const i = journal.findIndex((e) => e.tag === "0027_cycle_de_vie_des_versions");
    expect(i).toBeGreaterThan(0);
    expect(journal[i - 1]?.tag).toBe("0026_mode_ia_instance");
    expect(journal[i]?.idx).toBe((journal[i - 1]?.idx ?? 0) + 1);
    expect(journal[i]?.when ?? 0).toBeGreaterThan(journal[i - 1]?.when ?? Infinity);
    expect(journal.length).toBeGreaterThanOrEqual(i + 1);
    expect(lire("meta/0027_snapshot.json")["prevId"]).toBe(lire("meta/0026_snapshot.json")["id"]);
    expect(readdirSync(dossier).filter((f) => /^0027_.*\.sql$/.test(f))).toEqual([NOM]);
  });
});
