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

// Contrôles du schéma déclaré (sans base) : la preuve contre PostgreSQL est dans clients.int.test.ts (job socle-integration).
const colonnes = (t: Parameters<typeof getTableConfig>[0]) => Object.fromEntries(getTableConfig(t).columns.map((c) => [c.name, c]));

describe("schéma des organisations, contacts et instances", () => {
  it("[A-120] une organisation déclare SIREN, métier, code NAF, taille et statut, tous facultatifs sauf le statut", () => {
    const c = colonnes(organisations);
    for (const nom of ["siren", "metier", "code_naf", "taille"]) expect(c[nom]?.notNull, nom).toBe(false);
    expect(c["statut"]?.notNull).toBe(true);
    expect(migration).toContain("organisations_siren_format");
    expect(migration).toContain("organisations_code_naf_format");
  });

  it("[A-156] le statut est une énumération prospect, en_signature, client, ancien_client", () => {
    expect(colonnes(organisations)["statut"]?.enumValues).toEqual(["prospect", "en_signature", "client", "ancien_client"]);
  });

  it("[C-331] une organisation prospect ne demande que sa raison sociale : crm_company_id est facultatif", () => {
    const c = colonnes(organisations);
    expect(c["crm_company_id"]?.notNull).toBe(false);
    const obligatoires = Object.values(c).filter((x) => x.notNull && !x.hasDefault).map((x) => x.name).sort();
    expect(obligatoires).toEqual(["console_client_id", "id", "raison_sociale", "tenant_id"]);
  });

  it("[C-361] console_client_id est dérivé de tenant_id par CHECK, sans unicité globale", () => {
    expect(migration).toContain('CONSTRAINT "organisations_console_client_id_derive" CHECK ("organisations"."console_client_id" = "organisations"."tenant_id")');
    expect(migration).toContain('UNIQUE("tenant_id","console_client_id")');
    expect(migration).not.toMatch(/UNIQUE\("console_client_id"\)/);
  });

  it("[A-121] un contact déclare nom, e-mail, rôle, accès portail et id Keycloak facultatif", () => {
    const c = colonnes(contacts);
    for (const nom of ["nom", "email", "role", "acces_portail"]) expect(c[nom]?.notNull, nom).toBe(true);
    expect(c["keycloak_id"]?.notNull).toBe(false);
  });

  it("[A-126] l'état d'une instance est une énumération active, pause, erreur, livree", () => {
    expect(colonnes(instances)["etat"]?.enumValues).toEqual(["active", "pause", "erreur", "livree"]);
  });
});
