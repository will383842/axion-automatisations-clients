import { readdirSync, readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { analyserSql } from "../../../../../scripts/garde-migrations.ts";
import { alertes, cloturesAlertes, occurrencesAlertes } from "../../db/schema/exploitation.ts";

// Migration 0029 (T5-04a, ADR 0126) : file d'alertes, occurrences et clôtures motivées, une seule alerte en cours par client et par clé.
// Les essais contre PostgreSQL sont dans db/supervision.int.test.ts (aucun nouveau fichier d'essai en base : partition du socle, ADR 0121).
const dossier = new URL("../../../drizzle/", import.meta.url);
const NOM = "0029_file_d_alertes.sql";
const migration = () => readFileSync(new URL(NOM, dossier), "utf8");
const code = () => migration().replace(/--[^\n]*/g, "");
const lire = (f: string) => JSON.parse(readFileSync(new URL(f, dossier), "utf8")) as Record<string, unknown>;
const droits = (table: string, role: string) => [...code().matchAll(new RegExp(`GRANT ([A-Z, ]+(?:\\([^)]*\\))?) ON TABLE "public"\\."${table}" TO ${role}`, "g"))].map((m) => m[1] ?? "");
const TABLES = ["occurrences_alertes", "clotures_alertes"] as const;

describe("file d'alertes : schéma et migration 0029", () => {
  it("[B-395] la migration 0029 pose une seule alerte ouverte ou acquittée par client et par clé de regroupement (index unique partiel commençant par tenant_id)", () => {
    const i = getTableConfig(alertes).indexes.find((x) => x.config.name === "alertes_une_ouverte_par_cle");
    expect(i?.config.unique).toBe(true);
    expect(i?.config.columns.map((c) => (c as { name: string }).name)).toEqual(["tenant_id", "cle_regroupement"]);
    expect(code()).toContain(
      `CREATE UNIQUE INDEX "alertes_une_ouverte_par_cle" ON "alertes" USING btree ("tenant_id","cle_regroupement") WHERE "alertes"."cle_regroupement" IS NOT NULL AND "alertes"."etat" IN ('ouverte', 'acquittee')`,
    );
  });

  it("[B-427] occurrences_alertes compte les occurrences d'une alerte du même client : clé étrangère (tenant_id, alerte_id), relance en drapeau, recue_le absent des GRANT INSERT", () => {
    const fks = Object.fromEntries(getTableConfig(occurrencesAlertes).foreignKeys.map((f) => { const r = f.reference(); return [f.getName(), r.columns.map((c) => c.name).join(",") + " -> " + r.foreignColumns.map((c) => c.name).join(",")]; }));
    expect(fks["occurrences_alertes_alerte_fk"]).toBe("tenant_id,alerte_id -> tenant_id,id");
    expect(fks["occurrences_alertes_instance_fk"]).toBe("tenant_id,instance_id -> tenant_id,id");
    expect(getTableConfig(occurrencesAlertes).columns.map((c) => c.name)).toEqual(expect.arrayContaining(["relance", "recue_le", "instance_id"]));
    const insert = droits("occurrences_alertes", "console_app").find((d) => d.startsWith("INSERT")) ?? "";
    expect(insert).toContain('"relance"');
    expect(insert).not.toMatch(/"(recue_le|id)"/);
    expect(code()).toMatch(/CREATE POLICY acteur_obligatoire_insert ON "public"\."occurrences_alertes" AS RESTRICTIVE FOR INSERT TO console_app/);
  });

  it("[B-031] clotures_alertes : une clôture par alerte, raison en code, auteur = acteur, cree_le absent des GRANT INSERT", () => {
    const cfg = getTableConfig(cloturesAlertes);
    expect(cfg.uniqueConstraints.map((u) => u.name)).toContain("clotures_alertes_une_par_alerte");
    expect(cfg.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["clotures_alertes_raison_code", "clotures_alertes_auteur_borne"]));
    expect(cfg.columns.map((c) => c.name)).toContain("raison");
    expect(cfg.columns.map((c) => c.name)).not.toContain("motif");
    const t = code();
    expect(t).toContain(`CONSTRAINT "clotures_alertes_raison_code" CHECK ("clotures_alertes"."raison" ~ '^[a-z][a-z0-9_.-]{0,63}$')`);
    expect(t).toMatch(/CREATE POLICY auteur_insertion ON "public"\."clotures_alertes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK \(auteur = NULLIF\(current_setting\('app\.acteur', true\), ''\)\)/);
    const insert = droits("clotures_alertes", "console_app").find((d) => d.startsWith("INSERT")) ?? "";
    expect(insert).toContain('"raison"');
    expect(insert).toContain('"auteur"');
    expect(insert).not.toMatch(/"(cree_le|id)"/);
  });

  it("[B-031] la politique restrictive cloture_motivee exige une clôture pour passer une alerte à close", () => {
    expect(code()).toMatch(
      /CREATE POLICY cloture_motivee ON "public"\."alertes" AS RESTRICTIVE FOR UPDATE TO console_app USING \(true\) WITH CHECK \(etat <> 'close' OR EXISTS \(SELECT 1 FROM "public"\."clotures_alertes" c WHERE c\.tenant_id = alertes\.tenant_id AND c\.alerte_id = alertes\.id\)\)/,
    );
  });

  it("[B-395] une occurrence ou une clôture n'est acceptée que sur une alerte ouverte ou acquittée (deux politiques restrictives)", () => {
    const t = code();
    for (const [politique, table] of [["occurrence_sur_alerte_ouverte", "occurrences_alertes"], ["cloture_sur_alerte_ouverte", "clotures_alertes"]] as const) {
      expect(t, politique).toMatch(new RegExp(`CREATE POLICY ${politique} ON "public"\\."${table}" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK \\(EXISTS \\(SELECT 1 FROM "public"\\."alertes" a WHERE a\\.tenant_id = ${table}\\.tenant_id AND a\\.id = ${table}\\.alerte_id AND a\\.etat IN \\('ouverte', 'acquittee'\\)\\)\\)`));
    }
  });

  it("[LOT5-alertes] occurrences_alertes et clotures_alertes sont des tables de client : RLS activée et forcée, isolation_client, lecture_equipe, isolation_lecture, PUBLIC sans droit, aucun UPDATE, DELETE ni TRUNCATE", () => {
    const texte = code();
    for (const nom of TABLES) {
      expect(getTableConfig(nom === "clotures_alertes" ? cloturesAlertes : occurrencesAlertes).columns.map((c) => c.name), nom).toContain("tenant_id");
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(texte, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(texte, nom).toMatch(new RegExp(`CREATE POLICY isolation_client ON "public"\\."${nom}" FOR ALL TO console_app USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', true\\), ''\\)::uuid\\)`));
      expect(texte, nom).toMatch(new RegExp(`CREATE POLICY lecture_equipe ON "public"\\."${nom}" FOR SELECT TO console_equipe USING \\(tenant_id IS NOT NULL\\)`));
      expect(texte, nom).toMatch(new RegExp(`CREATE POLICY isolation_lecture ON "public"\\."${nom}" FOR SELECT TO console_lecture USING \\(tenant_id = NULLIF`));
      expect(texte, nom).toContain(`REVOKE ALL ON TABLE "public"."${nom}" FROM PUBLIC`);
      expect(texte, nom).toContain(`CREATE TRIGGER ${nom}_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."${nom}" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire()`);
      expect(droits(nom, "PUBLIC"), nom).toEqual([]);
      expect(droits(nom, "console_app"), nom).toContain("SELECT");
      expect(droits(nom, "console_equipe"), nom).toEqual(["SELECT"]);
      expect(droits(nom, "console_lecture"), nom).toEqual(["SELECT"]);
    }
    expect(texte).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*"(occurrences_alertes|clotures_alertes)"/i);
  });

  it("[LOT5-alertes] la migration 0029 est additive : analyserSql rend [], ni DROP, DELETE, TRUNCATE, RENAME, ALTER TYPE, ADD VALUE, ADD COLUMN, ALTER POLICY ni CREATE FUNCTION, aucun GRANT sur alertes", () => {
    expect(analyserSql(NOM, migration())).toEqual([]);
    const t = code();
    expect(t).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(t).not.toMatch(/ALTER\s+COLUMN[^;]*\bTYPE\b|\bALTER\s+TYPE\b|\bADD\s+VALUE\b|\bADD\s+COLUMN\b|\bALTER\s+POLICY\b/i);
    expect(t).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|SECURITY\s+DEFINER|^\s*DO\b|\bCONCURRENTLY\b/im);
    expect(t).not.toMatch(/GRANT[^;]*ON TABLE "public"\."alertes"/i);
    expect(t).not.toMatch(/ALTER TABLE "(public"\."|)alertes"/);
  });

  it("[LOT5-alertes] journal et instantané : 0029 suit 0028, when croît, prevId de 0029 = id de 0028, un seul fichier 0029", () => {
    const journal = (lire("meta/_journal.json") as { entries: { idx: number; tag: string; when: number }[] }).entries;
    const i = journal.findIndex((e) => e.tag === "0029_file_d_alertes");
    expect(i).toBeGreaterThan(0);
    expect(journal[i - 1]?.tag).toBe("0028_deploiement_instances");
    expect(journal[i]?.idx).toBe((journal[i - 1]?.idx ?? 0) + 1);
    expect(journal[i]?.when ?? 0).toBeGreaterThan(journal[i - 1]?.when ?? Infinity);
    expect(journal.length).toBeGreaterThanOrEqual(i + 1);
    expect(lire("meta/0029_snapshot.json")["prevId"]).toBe(lire("meta/0028_snapshot.json")["id"]);
    expect(readdirSync(dossier).filter((f) => /^0029_/.test(f))).toEqual([NOM]);
  });
});
