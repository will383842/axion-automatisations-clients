import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { tableClient, TABLES_CLIENT } from "./aides.ts";
import { contacts, instances, organisations } from "./clients.ts";
import { integer, uuid } from "drizzle-orm/pg-core";

const dossier = new URL("../../../drizzle/", import.meta.url);
const migration = readFileSync(new URL("0004_tables_clients.sql", dossier), "utf8");

describe("tableClient()", () => {
  const cles = (t: Parameters<typeof getTableConfig>[0]) => {
    const c = getTableConfig(t);
    return { pk: c.primaryKeys.map((k) => k.columns.map((x) => x.name)), uniques: c.uniqueConstraints.map((u) => u.columns.map((x) => x.name)), index: c.indexes.map((i) => i.config.columns.map((x) => (x as { name: string }).name)) };
  };

  it("[A-119] @isolation donne tenant_id NOT NULL, la clé primaire (tenant_id, id), UNIQUE (tenant_id, id) et un index qui commence par tenant_id", () => {
    for (const t of [organisations, contacts, instances]) {
      const c = cles(t);
      expect(c.pk).toEqual([["tenant_id", "id"]]);
      expect(c.uniques).toContainEqual(["tenant_id", "id"]);
      expect(c.index.some((i) => i[0] === "tenant_id")).toBe(true);
      expect(getTableConfig(t).columns.find((x) => x.name === "tenant_id")?.notNull).toBe(true);
    }
  });

  it("[A-119] @isolation l'option partitionnée donne la clé (tenant_id, id, debut) sans UNIQUE (tenant_id, id)", () => {
    const t = tableClient("essai_partitionnee", { id: uuid("id").notNull(), debut: integer("debut").notNull() }, { partitionnee: true });
    const c = cles(t);
    expect(c.pk).toEqual([["tenant_id", "id", "debut"]]);
    expect(c.uniques).toEqual([]);
  });
});

describe("migration des tables de client", () => {
  it("[A-119] @isolation chaque table de tableClient() a ENABLE et FORCE ROW LEVEL SECURITY, ses deux politiques et le déclencheur d'audit prévu", () => {
    expect(TABLES_CLIENT.map((t) => t.nom).filter((n) => !n.startsWith("essai_")).sort()).toEqual(["contacts", "instances", "organisations"]);
    for (const { nom, audit } of TABLES_CLIENT.filter((t) => !t.nom.startsWith("essai_"))) {
      expect(migration, nom).toContain(`ALTER TABLE "public"."${nom}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, nom).toContain(`ALTER TABLE "public"."${nom}" FORCE ROW LEVEL SECURITY`);
      expect(migration, nom).toMatch(new RegExp(`CREATE POLICY isolation_client ON "public"\\."${nom}" FOR ALL TO console_app USING \\(tenant_id = NULLIF\\(current_setting\\('app.tenant_id', true\\), ''\\)::uuid\\) WITH CHECK`));
      expect(migration, nom).toContain(`CREATE POLICY lecture_equipe ON "public"."${nom}" FOR SELECT TO console_equipe`);
      expect(migration.includes(`AFTER INSERT OR UPDATE OR DELETE ON "public"."${nom}" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire()`), nom).toBe(audit);
    }
  });

  it("[A-119] pas de TRUNCATE ni de REFERENCES accordé à console_app ou console_equipe", () => {
    expect(migration).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|ALL)\b[^;]*TO console_(app|equipe)/i);
  });
});
