import { describe, expect, it } from "vitest";
import { verifierMigrationsModule } from "./garde-migrations-module.ts";

// Garde des migrations d'un module (T4-28b2, ADR 0125) : union du filtre de T2-35 (texte) et de l'analyseur par arbre de la garde des migrations, sans aucune fonction permise.
const CODE = "gestion-devis";
const refuse = (sql: string) => verifierMigrationsModule([sql], CODE).length > 0;
const OK = 'CREATE TABLE "devis" ("id" uuid PRIMARY KEY, "libelle" text NOT NULL);--> statement-breakpoint\nALTER TABLE "devis" ADD COLUMN "note" text;';

describe("garde des migrations de module", () => {
  it("[A-300] une migration additive d'un module est acceptée", () => {
    expect(verifierMigrationsModule([OK], CODE)).toEqual([]);
  });

  it("[A-300] garde des migrations de module : ALTER COLUMN TYPE, RENAME, TRUNCATE, DELETE, DROP COLUMN et DROP NOT NULL sont refusés", () => {
    for (const sql of [
      'ALTER TABLE "devis" ALTER COLUMN "libelle" TYPE integer USING 0;',
      'ALTER TABLE "devis" RENAME COLUMN "libelle" TO "titre";',
      'ALTER TABLE "devis" RENAME TO "devis_v2";',
      'TRUNCATE "devis";',
      'DELETE FROM "devis";',
      'ALTER TABLE "devis" DROP COLUMN "libelle";',
      'DROP TABLE "devis";',
      'ALTER TABLE "devis" ALTER COLUMN "libelle" DROP NOT NULL;',
    ]) expect(refuse(sql), sql).toBe(true);
  });

  it("[A-300] garde des migrations de module : CREATE OR REPLACE VIEW, CREATE FUNCTION et CREATE RULE sont refusés", () => {
    for (const sql of [
      'CREATE OR REPLACE VIEW "vue_devis" AS SELECT 1 AS "un";',
      'CREATE FUNCTION "f"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
      'CREATE RULE "r" AS ON INSERT TO "devis" DO INSTEAD NOTHING;',
    ]) expect(refuse(sql), sql).toBe(true);
    // Une vue nouvelle (sans REPLACE) reste permise.
    expect(refuse('CREATE VIEW "vue_devis" AS SELECT 1 AS "un";')).toBe(false);
  });

  it("[A-300] garde des migrations de module : une écriture dans public, commun, trace ou a_<autre>, un GRANT ou un SET ROLE sont refusés", () => {
    for (const sql of [
      'INSERT INTO "public"."clients" ("id") VALUES (1);',
      'INSERT INTO "commun"."etablissements" ("id") VALUES (1);',
      'INSERT INTO "trace"."journal" ("id") VALUES (1);',
      'INSERT INTO "a_autre_module"."devis" ("id") VALUES (1);',
      'CREATE TABLE "public"."pirate" ("id" integer);',
      'GRANT ALL ON "devis" TO PUBLIC;',
      'SET ROLE postgres;',
    ]) expect(refuse(sql), sql).toBe(true);
  });

  it("[A-300] un refus donne un message par motif, sans citer le texte de la migration", () => {
    const r = verifierMigrationsModule(['DELETE FROM "devis" WHERE "libelle" = \'secret-xyz\';', 'DELETE FROM "devis";'], CODE);
    expect(r.length).toBeGreaterThan(0);
    expect(new Set(r).size).toBe(r.length);
    expect(r.join(" ")).not.toContain("secret-xyz");
  });

  it("[A-300] un code de module invalide ou trop long est refusé sans lever d'erreur", () => {
    expect(verifierMigrationsModule([OK], "Code Invalide").length).toBeGreaterThan(0);
    expect(verifierMigrationsModule([OK], "a".repeat(40)).length).toBeGreaterThan(0);
  });
});
