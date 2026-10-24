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
  CREATE TYPE statut_dossier AS ENUM ('ouvert', 'clos');
  CREATE TABLE dossiers (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, montant_centimes bigint NOT NULL, statut statut_dossier);
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
  CREATE TRIGGER journal_ajout_seul_tronque BEFORE TRUNCATE ON journal_audit FOR EACH STATEMENT EXECUTE FUNCTION refuser_modif();
`;
const TENANT = "tenant_id = current_setting('app.tenant_id')::uuid";
const NOTES = "CREATE TABLE notes (id bigint PRIMARY KEY, tenant_id uuid NOT NULL); CREATE INDEX n_t ON notes (tenant_id); ALTER TABLE notes ENABLE ROW LEVEL SECURITY; ALTER TABLE notes FORCE ROW LEVEL SECURITY;";
const EXECUTIONS = `CREATE TABLE executions (id bigint, tenant_id uuid NOT NULL, cree_le date NOT NULL, PRIMARY KEY (id, cree_le)) PARTITION BY RANGE (cree_le);
  CREATE INDEX executions_tenant ON executions (tenant_id, id);
  ALTER TABLE executions ENABLE ROW LEVEL SECURITY; ALTER TABLE executions FORCE ROW LEVEL SECURITY;
  CREATE POLICY isolation ON executions USING (${TENANT});`;
const PARTITION = "CREATE TABLE executions_2026_10 PARTITION OF executions FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');";

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
    await avec("force", `CREATE TABLE notes (id bigint PRIMARY KEY, tenant_id uuid NOT NULL); CREATE INDEX n_t ON notes (tenant_id); ALTER TABLE notes ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON notes USING (tenant_id = current_setting('app.tenant_id')::uuid);`,
      (e) => expect(e).toContainEqual({ regle: "force_rls_absent", objet: "notes" }));
  });

  it("[C-536] une table sans tenant_id NOT NULL ou sans index qui commence par tenant_id est signalée", async () => {
    await avec("tenant", `CREATE TABLE notes (id bigint PRIMARY KEY, tenant_id uuid); CREATE INDEX n_t ON notes (id, tenant_id); ALTER TABLE notes ENABLE ROW LEVEL SECURITY; ALTER TABLE notes FORCE ROW LEVEL SECURITY; CREATE POLICY p ON notes USING (tenant_id = current_setting('app.tenant_id')::uuid);
      CREATE TABLE autres (id bigint PRIMARY KEY);`,
      (e) => {
        expect(e).toContainEqual({ regle: "tenant_id_absent", objet: "notes" });
        expect(e).toContainEqual({ regle: "index_tenant_absent", objet: "notes" });
        expect(e).toContainEqual({ regle: "tenant_id_absent", objet: "autres" });
      });
  });

  it("[C-536] une base cli_ ouverte à PUBLIC est signalée", async () => {
    await avec("pub", "", (e) => expect(e).toContainEqual({ regle: "base_cli_ouverte", objet: `cli_${base("pub")}` }), `cli_${base("pub")}`);
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
    await avec("vocab", `CREATE TABLE etats (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, statut text);`, (e) => {
      expect(e).toContainEqual({ regle: "vocabulaire_en_texte", objet: "etats.statut" });
      expect(e.filter((x) => x.regle === "vocabulaire_en_texte")).toHaveLength(1);
    });
  });

  it("[C-536] une politique USING (true) est signalée, même avec RLS et FORCE", async () => {
    await avec("ouverte", `${NOTES} CREATE POLICY p ON notes USING (true);`,
      (e) => expect(e).toContainEqual({ regle: "politique_ouverte", objet: "notes" }));
    await avec("ouverte2", `${NOTES} CREATE POLICY p ON notes USING (${TENANT}) WITH CHECK (true);`,
      (e) => expect(e).toContainEqual({ regle: "politique_ouverte", objet: "notes" }));
    await avec("ouverte3", `${NOTES} CREATE POLICY p ON notes FOR INSERT WITH CHECK (true);`,
      (e) => expect(e).toContainEqual({ regle: "politique_ouverte", objet: "notes" }));
  });

  it("[C-536] des politiques qui citent tenant_id (une par commande) ne sont pas signalées", async () => {
    await avec("pol", `${NOTES} CREATE POLICY lire ON notes FOR SELECT USING (${TENANT}); CREATE POLICY ecrire ON notes FOR INSERT WITH CHECK (${TENANT});
      CREATE POLICY maj ON notes FOR UPDATE USING (${TENANT}) WITH CHECK (${TENANT}); CREATE POLICY suppr ON notes FOR DELETE USING (${TENANT});`,
      (e) => expect(e).toEqual([]));
  });

  it("[C-536] une partition sans RLS, sans FORCE ou sans politique est signalée, même si le parent est conforme", async () => {
    await avec("part", `${EXECUTIONS} ${PARTITION}`, (e) => {
      expect(e).toContainEqual({ regle: "rls_absente", objet: "executions_2026_10" });
      expect(e).toContainEqual({ regle: "force_rls_absent", objet: "executions_2026_10" });
      expect(e.filter((x) => x.objet === "executions")).toEqual([]);
    });
    await avec("part2", `${EXECUTIONS} ${PARTITION} ALTER TABLE executions_2026_10 ENABLE ROW LEVEL SECURITY; ALTER TABLE executions_2026_10 FORCE ROW LEVEL SECURITY;`, (e) => {
      expect(e).toContainEqual({ regle: "rls_absente", objet: "executions_2026_10" });
      expect(regles(e)).not.toContain("force_rls_absent");
    });
  });

  it("[C-536] une partition conforme (RLS, FORCE, politique) n'est pas signalée", async () => {
    await avec("part3", `${EXECUTIONS} ${PARTITION} ALTER TABLE executions_2026_10 ENABLE ROW LEVEL SECURITY; ALTER TABLE executions_2026_10 FORCE ROW LEVEL SECURITY;
      CREATE POLICY isolation ON executions_2026_10 USING (${TENANT});`, (e) => expect(e).toEqual([]));
  });

  it("[C-536] un rôle de l'application avec BYPASSRLS ou superutilisateur est signalé", async () => {
    const bypass = `app_c5_bypass_${process.pid}`;
    const sup = `app_c5_super_${process.pid}`;
    const sain = `app_c5_sain_${process.pid}`;
    psql(undefined, `CREATE ROLE ${bypass} BYPASSRLS; CREATE ROLE ${sup} SUPERUSER; CREATE ROLE ${sain}`);
    try {
      await avec("roles", "", (e) => {
        expect(e).toContainEqual({ regle: "role_contourne_rls", objet: bypass });
        expect(e).toContainEqual({ regle: "role_contourne_rls", objet: sup });
        expect(e).not.toContainEqual({ regle: "role_contourne_rls", objet: sain });
      });
    } finally {
      psql(undefined, `DROP ROLE IF EXISTS ${bypass}, ${sup}, ${sain}`);
    }
  });

  it("[C-536] une table d'un autre schéma que public est contrôlée ; seule la table de migrations est exemptée", async () => {
    await avec("schema", `CREATE SCHEMA metier; CREATE TABLE metier.notes (id bigint PRIMARY KEY, tenant_id uuid NOT NULL);
      CREATE TABLE __migrations (id bigint PRIMARY KEY); CREATE TABLE __autre (id bigint PRIMARY KEY);`, (e) => {
      expect(e).toContainEqual({ regle: "rls_absente", objet: "metier.notes" });
      expect(e).toContainEqual({ regle: "tenant_id_absent", objet: "__autre" });
      expect(e.filter((x) => x.objet === "__migrations")).toEqual([]);
    });
  });

  it("[C-536] un index qui ne commence pas par tenant_id (INCLUDE, expression, partiel) est signalé", async () => {
    const base = "(id bigint PRIMARY KEY, tenant_id uuid NOT NULL)";
    const regime = (t: string) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${t} FORCE ROW LEVEL SECURITY; CREATE POLICY p ON ${t} USING (${TENANT});`;
    for (const [nom, index] of [["inc", "(id) INCLUDE (tenant_id)"], ["expr", "(lower(tenant_id::text))"], ["part", "(tenant_id) WHERE id > 0"], ["autre", "(id, tenant_id)"]] as const) {
      await avec(`idx_${nom}`, `CREATE TABLE notes ${base}; CREATE INDEX n_t ON notes ${index}; ${regime("notes")}`,
        (e) => expect(e).toContainEqual({ regle: "index_tenant_absent", objet: "notes" }));
    }
    await avec("idx_ok", `CREATE TABLE notes ${base}; CREATE INDEX n_t ON notes ("tenant_id", id); ${regime("notes")}`, (e) => expect(e).toEqual([]));
  });

  it("[LOT0-c5] un journal sans blocage de TRUNCATE ou dont le déclencheur ne vaut qu'en réplique est signalé", async () => {
    await avec("trunc", `DROP TRIGGER journal_ajout_seul_tronque ON journal_audit;`, (e) => expect(e).toContainEqual({ regle: "journal_modifiable", objet: "journal_audit" }));
    await avec("replica", `ALTER TABLE journal_audit ENABLE REPLICA TRIGGER journal_ajout_seul;`, (e) => expect(e).toContainEqual({ regle: "journal_modifiable", objet: "journal_audit" }));
    await avec("always", `ALTER TABLE journal_audit ENABLE ALWAYS TRIGGER journal_ajout_seul;`, (e) => expect(e).toEqual([]));
  });
});
