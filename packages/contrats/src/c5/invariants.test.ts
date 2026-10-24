import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { VOCABULAIRE, controlerInvariants, type Ecart, type Requete } from "./invariants.ts";

// Ces tests ont besoin d'un PostgreSQL : l'URL d'un serveur jetable est dans CONTRATS_PG_URL
// (job contrats-pg de la CI). Sans elle, ils sont sautés et la PR le dit.
const URL_PG = process.env.CONTRATS_PG_URL;
const psql = (base: string | undefined, sql: string): string => {
  const u = new URL(URL_PG as string);
  if (base) u.pathname = `/${base}`;
  return execFileSync("psql", [u.toString(), "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], { encoding: "utf8" });
};
const requeteSur = (base: string): Requete => async (sql) => {
  const sortie = psql(base, `SELECT coalesce(json_agg(t), '[]') FROM (${sql}) t`).trim();
  return JSON.parse(sortie) as Record<string, unknown>[];
};

const CONFORME = `
  CREATE TABLE dossiers (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, montant_centimes bigint NOT NULL, statut text);
  CREATE INDEX dossiers_tenant ON dossiers (tenant_id, id);
  ALTER TABLE dossiers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dossiers FORCE ROW LEVEL SECURITY;
  CREATE POLICY isolation ON dossiers USING (tenant_id = current_setting('app.tenant_id')::uuid);
  CREATE TABLE journal_audit (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, action text NOT NULL);
  CREATE INDEX journal_audit_tenant ON journal_audit (tenant_id, id);
  ALTER TABLE journal_audit ENABLE ROW LEVEL SECURITY;
  ALTER TABLE journal_audit FORCE ROW LEVEL SECURITY;
  CREATE POLICY isolation ON journal_audit USING (tenant_id = current_setting('app.tenant_id')::uuid);
  CREATE FUNCTION refuser_modif() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'journal en ajout seul'; END $$;
  CREATE TRIGGER journal_ajout_seul BEFORE UPDATE OR DELETE ON journal_audit FOR EACH ROW EXECUTE FUNCTION refuser_modif();
`;

const base = (nom: string) => `contrats_c5_${nom}_${process.pid}`;
async function avec(nom: string, sql: string, fn: (ecarts: Ecart[]) => void, nomBase = base(nom)): Promise<void> {
  psql(undefined, `CREATE DATABASE ${nomBase}`);
  try {
    psql(nomBase, CONFORME + sql);
    fn(await controlerInvariants(requeteSur(nomBase), nomBase));
  } finally {
    psql(undefined, `DROP DATABASE IF EXISTS ${nomBase}`);
  }
}
const regles = (e: Ecart[]) => e.map((x) => x.regle);

describe.skipIf(!URL_PG)("C5 invariants du schéma", () => { // fiche: T0-16
  it("[LOT0-c5] un schéma conforme ne produit aucun écart", async () => {
    await avec("ok", "", (e) => expect(e).toEqual([]));
  });

  it("[C-536] une table sans politique RLS est signalée", async () => {
    await avec("rls", `CREATE TABLE notes (id bigint PRIMARY KEY, tenant_id uuid NOT NULL); CREATE INDEX n_t ON notes (tenant_id); ALTER TABLE notes ENABLE ROW LEVEL SECURITY; ALTER TABLE notes FORCE ROW LEVEL SECURITY;`,
      (e) => expect(e).toContainEqual({ regle: "rls_absente", objet: "notes" }));
  });

  it("[C-536] une table sans FORCE ROW LEVEL SECURITY est signalée", async () => {
    await avec("force", `CREATE TABLE notes (id bigint PRIMARY KEY, tenant_id uuid NOT NULL); CREATE INDEX n_t ON notes (tenant_id); ALTER TABLE notes ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON notes USING (true);`,
      (e) => expect(e).toContainEqual({ regle: "force_rls_absent", objet: "notes" }));
  });

  it("[C-536] une table sans tenant_id NOT NULL ou sans index qui commence par tenant_id est signalée", async () => {
    await avec("tenant", `CREATE TABLE notes (id bigint PRIMARY KEY, tenant_id uuid); CREATE INDEX n_t ON notes (id, tenant_id); ALTER TABLE notes ENABLE ROW LEVEL SECURITY; ALTER TABLE notes FORCE ROW LEVEL SECURITY; CREATE POLICY p ON notes USING (true);
      CREATE TABLE autres (id bigint PRIMARY KEY);`,
      (e) => {
        expect(e).toContainEqual({ regle: "tenant_id_absent", objet: "notes" });
        expect(e).toContainEqual({ regle: "index_tenant_absent", objet: "notes" });
        expect(e).toContainEqual({ regle: "tenant_id_absent", objet: "autres" });
      });
  });

  it("[C-536] une base cli_ ouverte à PUBLIC est signalée", async () => {
    await avec("pub", "", (e) => expect(e).toContainEqual({ regle: "base_cli_ouverte", objet: base("pub") }), `cli_${base("pub")}`);
  });

  it("[C-536] une base cli_ fermée à PUBLIC n'est pas signalée", async () => {
    const nom = `cli_${base("ferme")}`;
    psql(undefined, `CREATE DATABASE ${nom}`);
    try {
      psql(undefined, `REVOKE CONNECT ON DATABASE ${nom} FROM PUBLIC`);
      expect(regles(await controlerInvariants(requeteSur(nom), nom))).not.toContain("base_cli_ouverte");
    } finally {
      psql(undefined, `DROP DATABASE IF EXISTS ${nom}`);
    }
  });

  it("[LOT0-c5] le rôle de l'application propriétaire d'une table est signalé", async () => {
    const role = `app_c5_${process.pid}`;
    psql(undefined, `CREATE ROLE ${role}`);
    try {
      await avec("proprio", `CREATE TABLE notes (id bigint PRIMARY KEY, tenant_id uuid NOT NULL); ALTER TABLE notes OWNER TO ${role};`,
        (e) => expect(e).toContainEqual({ regle: "proprietaire_application", objet: "notes" }), base("proprio"));
    } finally {
      psql(undefined, `DROP ROLE IF EXISTS ${role}`);
    }
  });

  it("[LOT0-c5] une colonne montant_centimes en numeric est signalée", async () => {
    await avec("argent", `CREATE TABLE lignes (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, montant_centimes numeric, prix_ht double precision, total real);`,
      (e) => {
        expect(e).toContainEqual({ regle: "argent_non_entier", objet: "lignes.montant_centimes" });
        expect(e).toContainEqual({ regle: "argent_non_entier", objet: "lignes.prix_ht" });
        expect(e).toContainEqual({ regle: "argent_non_entier", objet: "lignes.total" });
      });
  });

  it("[LOT0-c5] un journal d'audit modifiable est signalé", async () => {
    await avec("audit", `DROP TRIGGER journal_ajout_seul ON journal_audit;`, (e) => expect(e).toContainEqual({ regle: "journal_modifiable", objet: "journal_audit" }));
    await avec("audit2", `DROP TRIGGER journal_ajout_seul ON journal_audit; CREATE TRIGGER t BEFORE UPDATE ON journal_audit FOR EACH ROW EXECUTE FUNCTION refuser_modif();`,
      (e) => expect(e).toContainEqual({ regle: "journal_modifiable", objet: "journal_audit" }));
  });

  it("[LOT0-c5] une colonne de vocabulaire en text est signalée, en énumération elle est acceptée", async () => {
    expect(VOCABULAIRE).toContain("statut");
    await avec("vocab", `CREATE TYPE etat AS ENUM ('a','b'); CREATE TABLE etats (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, statut etat);`,
      (e) => expect(e.filter((x) => x.regle === "vocabulaire_en_texte")).toEqual([{ regle: "vocabulaire_en_texte", objet: "dossiers.statut" }]));
  });
});
