import { readdirSync, readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { analyserSql } from "../../../../scripts/garde-migrations.ts";
import { instances } from "../db/schema/clients.ts";
import { configurations, deploiementsInstance, resultatTestABlanc, testsABlanc } from "../db/schema/exploitation.ts";
import { resultatVersion } from "../db/schema/bases-client.ts";

// Migration 0028 (T4-28a, ADR 0125) : tests à blanc, journal des déploiements, une instance par client, automatisation et environnement.
// Les essais contre PostgreSQL sont dans db/clients.int.test.ts (aucun nouveau fichier d'essai en base : partition du socle, ADR 0121).
const dossier = new URL("../../drizzle/", import.meta.url);
const NOM = "0028_deploiement_instances.sql";
const migration = () => readFileSync(new URL(NOM, dossier), "utf8");
const code = () => migration().replace(/--[^\n]*/g, "");
const lire = (f: string) => JSON.parse(readFileSync(new URL(f, dossier), "utf8")) as Record<string, unknown>;
const checks = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).checks.map((c) => c.name);
const droits = (table: string, role: string) => [...code().matchAll(new RegExp(`GRANT ([A-Z, ]+(?:\\([^)]*\\))?) ON TABLE "public"\\."${table}" TO ${role}`, "g"))].map((m) => m[1] ?? "");
const TABLES = ["tests_a_blanc", "deploiements_instance"] as const;

describe("déploiement d'un module chez un client : schéma et migration 0028", () => {
  it("[B-093] la migration 0028 crée tests_a_blanc : un test réussi n'a aucun envoi ni code, un test échoué a un code, compteurs et durée bornés", () => {
    expect(resultatTestABlanc.enumValues).toEqual(["reussi", "echoue"]);
    expect(checks(testsABlanc)).toEqual(
      expect.arrayContaining(["tests_a_blanc_compteurs_bornes", "tests_a_blanc_duree_bornee", "tests_a_blanc_reussi_sans_envoi", "tests_a_blanc_echec_motive", "tests_a_blanc_code_erreur_format", "tests_a_blanc_auteur_borne"]),
    );
    const t = code();
    expect(t).toContain('CREATE TABLE "tests_a_blanc"');
    expect(t).toMatch(/"tests_a_blanc_reussi_sans_envoi" CHECK \("tests_a_blanc"\."resultat" <> 'reussi' OR \("tests_a_blanc"\."envois" = 0 AND "tests_a_blanc"\."code_erreur" IS NULL\)\)/);
    expect(t).toMatch(/"tests_a_blanc_echec_motive" CHECK \("tests_a_blanc"\."resultat" <> 'echoue' OR "tests_a_blanc"\."code_erreur" IS NOT NULL\)/);
    expect(t).toMatch(/"tests_a_blanc_duree_bornee" CHECK \("tests_a_blanc"\."duree_ms" BETWEEN 0 AND 3600000\)/);
    expect(t).toMatch(/"tests_a_blanc_compteurs_bornes" CHECK \([^;]*"lectures" BETWEEN 0 AND 1000000[^;]*"brouillons" BETWEEN 0 AND 1000000[^;]*"envois" BETWEEN 0 AND 1000000/);
    // Un code, jamais un message : même règle que executions.code_erreur.
    expect(t).toMatch(/"tests_a_blanc_code_erreur_format" CHECK[^;]*\^\[a-z0-9_\.-\]\{1,64\}\$/);
    expect(resultatVersion.enumValues).toEqual(["ok", "echec", "quarantaine"]);
    expect(getTableConfig(deploiementsInstance).columns.find((c) => c.name === "resultat")?.getSQLType()).toBe("resultat_version");
    expect(checks(deploiementsInstance)).toEqual(expect.arrayContaining(["deploiements_instance_versions_distinctes", "deploiements_instance_cause_selon_resultat", "deploiements_instance_cause_format", "deploiements_instance_vague_bornee", "deploiements_instance_auteur_borne"]));
  });

  it("[B-093] tests_a_blanc lie le test à l'instance, à la version et à la configuration de cette instance (clé étrangère à trois colonnes)", () => {
    const fks = (t: Parameters<typeof getTableConfig>[0]) =>
      Object.fromEntries(getTableConfig(t).foreignKeys.map((f) => { const r = f.reference(); return [f.getName(), r.columns.map((c) => c.name).join(",") + " -> " + r.foreignColumns.map((c) => c.name).join(",")]; }));
    expect(fks(testsABlanc)["tests_a_blanc_configuration_fk"]).toBe("tenant_id,instance_id,configuration_id -> tenant_id,instance_id,id");
    expect(fks(testsABlanc)["tests_a_blanc_instance_fk"]).toBe("tenant_id,instance_id -> tenant_id,id");
    expect(fks(testsABlanc)["tests_a_blanc_version_fk"]).toBe("version_id -> id");
    expect(fks(deploiementsInstance)["deploiements_instance_configuration_fk"]).toBe("tenant_id,instance_id,configuration_id -> tenant_id,instance_id,id");
    const t = code();
    expect(t).toContain('CREATE UNIQUE INDEX "configurations_tenant_instance_id_unique" ON "configurations" USING btree ("tenant_id","instance_id","id")');
    expect(t).toMatch(/"tests_a_blanc_configuration_fk" FOREIGN KEY \("tenant_id","instance_id","configuration_id"\) REFERENCES "public"\."configurations"\("tenant_id","instance_id","id"\)/);
    expect(getTableConfig(configurations).indexes.map((i) => i.config.name)).toContain("configurations_tenant_instance_id_unique");
  });

  it("[B-312] la migration 0028 pose une seule instance par client, automatisation et environnement (index unique partiel commençant par tenant_id)", () => {
    const i = getTableConfig(instances).indexes.find((x) => x.config.name === "instances_une_par_automatisation");
    expect(i?.config.unique).toBe(true);
    expect(i?.config.columns.map((c) => (c as { name: string }).name)).toEqual(["tenant_id", "automatisation_id", "environnement"]);
    expect(code()).toContain('CREATE UNIQUE INDEX "instances_une_par_automatisation" ON "instances" USING btree ("tenant_id","automatisation_id","environnement") WHERE "instances"."automatisation_id" IS NOT NULL');
  });

  it("[A-119] tests_a_blanc et deploiements_instance sont des tables de client : tenant_id, RLS activée et forcée, isolation_client pour console_app, aucun droit pour console_lecture ni PUBLIC", () => {
    const texte = code();
    for (const nom of TABLES) {
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(texte, nom).toMatch(new RegExp(`CREATE POLICY isolation_client ON "public"\\."${nom}" FOR ALL TO console_app USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', true\\), ''\\)::uuid\\)`));
      expect(texte, nom).toMatch(new RegExp(`CREATE POLICY auteur_insertion ON "public"\\."${nom}" AS RESTRICTIVE FOR INSERT TO console_app`));
      expect(texte, nom).toContain(`REVOKE ALL ON TABLE "public"."${nom}" FROM PUBLIC`);
      expect(texte, nom).toContain(`CREATE TRIGGER ${nom}_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."${nom}" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire()`);
      expect(droits(nom, "console_lecture"), nom).toEqual([]);
      expect(droits(nom, "PUBLIC"), nom).toEqual([]);
    }
    expect(getTableConfig(testsABlanc).columns.map((c) => c.name)).toContain("tenant_id");
    expect(getTableConfig(deploiementsInstance).columns.map((c) => c.name)).toContain("tenant_id");
  });

  it("[A-119] tests_a_blanc et deploiements_instance sont en ajout seul : aucun GRANT UPDATE, DELETE ni TRUNCATE, cree_le absent des GRANT INSERT", () => {
    expect(code()).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*"(tests_a_blanc|deploiements_instance)"/i);
    for (const nom of TABLES) {
      expect(droits(nom, "console_app").filter((d) => d.startsWith("INSERT")), nom).toHaveLength(1);
      const insert = droits(nom, "console_app").find((d) => d.startsWith("INSERT")) ?? "";
      expect(insert, nom).not.toMatch(/"(cree_le|id)"/);
      expect(insert, nom).toContain('"auteur"');
      expect(droits(nom, "console_app"), nom).toContain("SELECT");
      expect(droits(nom, "console_equipe"), nom).toEqual(["SELECT"]);
    }
  });

  it("[LOT4-deploiement] la migration 0028 est additive : analyserSql rend [], ni DROP, ni DELETE, ni TRUNCATE, ni RENAME, ni ALTER TYPE, ni ADD VALUE, ni CREATE FUNCTION, ni colonne ajoutée à instances", () => {
    expect(analyserSql(NOM, migration())).toEqual([]);
    const t = code();
    expect(t).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(t).not.toMatch(/ALTER\s+COLUMN[^;]*\bTYPE\b|\bALTER\s+TYPE\b|\bADD\s+VALUE\b/i);
    expect(t).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|SECURITY\s+DEFINER|^\s*DO\b|\bCONCURRENTLY\b/im);
    expect(t).not.toMatch(/ALTER TABLE "(public"\."|)instances"/);
  });

  it("[LOT4-deploiement] journal et instantané : 0028 suit 0027, quand croît, prevId de 0028 = id de 0027, un seul fichier 0028", () => {
    const journal = (lire("meta/_journal.json") as { entries: { idx: number; tag: string; when: number }[] }).entries;
    const i = journal.findIndex((e) => e.tag === "0028_deploiement_instances");
    expect(i).toBeGreaterThan(0);
    expect(journal[i - 1]?.tag).toBe("0027_cycle_de_vie_des_versions");
    expect(journal[i]?.idx).toBe((journal[i - 1]?.idx ?? 0) + 1);
    expect(journal[i]?.when ?? 0).toBeGreaterThan(journal[i - 1]?.when ?? Infinity);
    expect(journal.length).toBeGreaterThanOrEqual(i + 1);
    expect(lire("meta/0028_snapshot.json")["prevId"]).toBe(lire("meta/0027_snapshot.json")["id"]);
    expect(readdirSync(dossier).filter((f) => /^0028_/.test(f))).toEqual([NOM]);
  });
});
