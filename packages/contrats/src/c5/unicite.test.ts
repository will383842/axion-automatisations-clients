import { describe, expect, it } from "vitest";
import { EXCEPTIONS_UNICITE, TENANT_FACULTATIF, controlerInvariants, type Requete } from "./invariants.ts";

// Faux PostgreSQL : répond selon un morceau distinctif du SQL demandé, [] pour le reste.
// Ces tests tournent sans base (job `tests`) ; les mêmes règles sont éprouvées sur un vrai PostgreSQL dans apps/api/src/db/unicite.int.test.ts.
type Unique = { oid: number; index: string; primaire: boolean; porte_tenant: boolean; identite_generee: boolean };
type Etrangere = { oid: number; cible: number; nom: string; lie_tenant: boolean };
type Monde = { tables: string[]; nullable?: string[]; sansIndex?: string[]; uniques?: Unique[]; etrangeres?: Etrangere[] };

const OPTIONS = { rolesApplication: /^app(_|$)/ };

// Chaque table est conforme (RLS, FORCE, politique citant tenant_id, index commençant par tenant_id) : seules les règles testées ici peuvent parler.
// oid d'une table = sa position (à partir de 1) dans `tables`.
function faux(monde: Monde): Requete {
  const tables = monde.tables.map((nom, i) => ({ oid: i + 1, schema: "public", nom }));
  return async (sql) => {
    if (sql.includes("indisunique")) return (monde.uniques ?? []) as Record<string, unknown>[];
    if (sql.includes("contype = 'f'")) return (monde.etrangeres ?? []) as Record<string, unknown>[];
    if (sql.includes("FROM pg_class c")) return tables.map((t) => ({ ...t, rls: true, force_rls: true, proprietaire: "migration", membres: ["migration"] }));
    if (sql.includes("information_schema.columns")) {
      return tables.map((t) => ({ schema: "public", table: t.nom, colonne: "tenant_id", type: "uuid", nullable: (monde.nullable ?? []).includes(t.nom) ? "YES" : "NO" }));
    }
    if (sql.includes("pg_policies")) return tables.map((t) => ({ schema: "public", table: t.nom, permissive: "PERMISSIVE", cmd: "ALL", qual: "(tenant_id = current_setting('app.tenant_id')::uuid)", with_check: null }));
    if (sql.includes("i.indisvalid")) return tables.filter((t) => !(monde.sansIndex ?? []).includes(t.nom)).map((t) => ({ oid: t.oid }));
    if (sql.includes("pg_trigger")) {
      return tables.filter((t) => t.nom === "journal_audit").map((t) => ({ oid: t.oid, type: 8 | 16 | 32, actif: "O" }));
    }
    return [];
  };
}
const unique = (extra: Partial<Unique>): Unique => ({ oid: 1, index: "comptes_courriel_key", primaire: false, porte_tenant: false, identite_generee: false, ...extra });
const regles = async (monde: Monde, options: object = OPTIONS) =>
  (await controlerInvariants(faux(monde), "console", options as never)).filter((e) => e.regle === "unicite_sans_tenant" || e.regle === "etrangere_sans_tenant" || e.regle === "tenant_id_absent");

describe("C5 · unicité et clés étrangères par client", () => {
  it("[A-163] @isolation une table avec tenant_id et un index unique sans tenant_id est signalée", async () => {
    expect(await regles({ tables: ["comptes"], uniques: [unique({})] })).toEqual([{ regle: "unicite_sans_tenant", objet: "comptes.comptes_courriel_key" }]);
  });

  it("[A-163] @isolation un index unique (tenant_id, valeur) est accepté", async () => {
    expect(await regles({ tables: ["comptes"], uniques: [unique({ porte_tenant: true })] })).toEqual([]);
  });

  it("[A-163] @isolation la clé primaire sur un identifiant généré est acceptée", async () => {
    expect(await regles({ tables: ["comptes"], uniques: [unique({ index: "comptes_pkey", primaire: true, identite_generee: true })] })).toEqual([]);
    // Une clé primaire qui n'est pas une identité GENERATED ALWAYS (uuid, BY DEFAULT) reste signalée.
    expect(await regles({ tables: ["comptes"], uniques: [unique({ index: "comptes_pkey", primaire: true })] })).toEqual([{ regle: "unicite_sans_tenant", objet: "comptes.comptes_pkey" }]);
    // Une identité générée qui n'est pas la clé primaire (simple unique) reste signalée.
    expect(await regles({ tables: ["comptes"], uniques: [unique({ identite_generee: true })] })).toHaveLength(1);
  });

  it("[A-163] @isolation une exception hors de la liste fermée est refusée", async () => {
    expect(EXCEPTIONS_UNICITE).toEqual([]);
    expect(Object.isFrozen(EXCEPTIONS_UNICITE)).toBe(true);
    const tentative = { ...OPTIONS, exceptionsUnicite: [{ table: "comptes", index: "comptes_courriel_key", raison: "essai" }] };
    expect(await regles({ tables: ["comptes"], uniques: [unique({})] }, tentative)).toEqual([{ regle: "unicite_sans_tenant", objet: "comptes.comptes_courriel_key" }]);
  });

  it("[A-163] @isolation une clé étrangère entre deux tables à tenant_id qui ne lie pas tenant_id à tenant_id est signalée", async () => {
    const monde = (lie_tenant: boolean): Monde => ({ tables: ["instances", "contacts"], etrangeres: [{ oid: 2, cible: 1, nom: "contacts_instance_fkey", lie_tenant }] });
    expect(await regles(monde(false))).toEqual([{ regle: "etrangere_sans_tenant", objet: "contacts.contacts_instance_fkey" }]);
    expect(await regles(monde(true))).toEqual([]);
  });

  it("[A-163] @isolation seule public.journal_audit peut avoir un tenant_id facultatif", async () => {
    expect(TENANT_FACULTATIF).toEqual(["public.journal_audit"]);
    expect(Object.isFrozen(TENANT_FACULTATIF)).toBe(true);
    expect(await regles({ tables: ["journal_audit"], nullable: ["journal_audit"] })).toEqual([]);
    expect(await regles({ tables: ["notes"], nullable: ["notes"] })).toEqual([{ regle: "tenant_id_absent", objet: "notes" }]);
  });

  it("[A-119] @isolation journal_audit garde l'exigence d'un index commençant par tenant_id malgré son tenant_id facultatif", async () => {
    const e = await controlerInvariants(faux({ tables: ["journal_audit"], nullable: ["journal_audit"], sansIndex: ["journal_audit"] }), "console", OPTIONS);
    expect(e).toEqual([{ regle: "index_tenant_absent", objet: "journal_audit" }]);
  });
});
