import { readFileSync } from "node:fs";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TABLES_COMMUNES } from "../../../../../packages/contrats/src/c5/invariants.ts";
import { analyserSql } from "../../../../../scripts/garde-migrations.ts";
import { TABLES_CLIENT } from "./aides.ts";
import * as portail from "./portail.ts";

// Contrôles sans base de données de la migration 0025 (T6-01a, tables du portail dans console) ; les essais contre PostgreSQL sont dans db/portail.int.test.ts.
const NOM = "0025_portail.sql";
const migration = readFileSync(new URL(`../../../drizzle/${NOM}`, import.meta.url), "utf8");
const code = migration.replace(/--[^\n]*/g, "");
const TABLES = ["progression_premiers_pas", "preferences_notifications", "invitations", "accords_logo", "compteurs_ecrans"];
const tables = (): PgTable[] => [portail.progressionPremiersPas, portail.preferencesNotifications, portail.invitations, portail.accordsLogo, portail.compteursEcrans];
const colonnes = (t: PgTable) => getTableConfig(t).columns.map((c) => c.name);

describe("portail : schéma et migration 0025", () => {
  it("[LOT6-tables] les cinq tables du portail sont des tables de client (tenant_id), aucune n'est commune", () => {
    expect(tables().map((t) => getTableConfig(t).name).sort()).toEqual([...TABLES].sort());
    for (const nom of TABLES) {
      expect(TABLES_CLIENT.map((t) => t.nom), nom).toContain(nom);
      expect(TABLES_COMMUNES, nom).not.toContain(`public.${nom}`);
    }
    for (const t of tables()) expect(colonnes(t)).toContain("tenant_id");
  });

  it("[LOT6-tables] invitations ne contient aucune colonne de jeton en clair", () => {
    expect(colonnes(portail.invitations).sort()).toEqual(
      ["acceptee_le", "cree_le", "empreinte_invitation", "etat", "expire_le", "id", "invite_par", "organisation_id", "role", "tenant_id"].sort(),
    );
    expect(colonnes(portail.invitations).filter((c) => /jeton|token|secret|mot_de_passe/i.test(c))).toEqual([]);
    expect(migration).toContain('"invitations_empreinte_forme" CHECK ("invitations"."empreinte_invitation" ~ \'^[0-9a-f]{64}$\')');
  });

  it("[C-604] la base console n'a aucune colonne capable de ranger le texte d'une demande", () => {
    for (const t of tables()) {
      const { name, columns, checks } = getTableConfig(t);
      const verifs = checks.map((c) => JSON.stringify(c.value));
      for (const c of columns.filter((x) => x.getSQLType() === "text")) {
        const borne = verifs.some((v) => v.includes(`"${c.name}"`) && /\{\d+,(\d+)\}/.test(v) && Number(/\{\d+,(\d+)\}/.exec(v)?.[1]) <= 128);
        expect(borne, `${name}.${c.name} : texte non borné à 129 caractères au plus`).toBe(true);
      }
      expect(columns.filter((c) => /json|bytea|\[\]/.test(c.getSQLType())), name).toEqual([]);
    }
  });

  it("[LOT6-tables] garde-migrations : migration 0025 additive seulement, sans fonction", () => {
    expect(analyserSql(NOM, migration)).toEqual([]);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/ALTER\s+(TABLE\s+\S+\s+ALTER\s+COLUMN|COLUMN)[^;]*\bTYPE\b/i);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b|GRANT[^;]*\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|SECURITY\s+DEFINER/i);
  });

  it("[LOT6-tables] @isolation chaque table a RLS activée et forcée, la politique du client, PUBLIC sans droit et l'acteur obligatoire", () => {
    for (const nom of TABLES) {
      expect(migration, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(migration, nom).toContain(`REVOKE ALL ON TABLE "public"."${nom}" FROM PUBLIC`);
      expect(migration, nom).toMatch(new RegExp(`CREATE POLICY isolation_client ON "public"\\."${nom}" FOR ALL TO console_app USING \\(tenant_id = NULLIF`));
      expect(migration, nom).toContain(`CREATE POLICY acteur_obligatoire_insert ON "public"."${nom}" AS RESTRICTIVE FOR INSERT`);
    }
  });
});
