import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient, avecEquipe } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Journal d'audit chaîné (T2-01a), contre le socle lancé par ops/socle/lancer.sh (job socle-integration).
// Les essais tournent en parallèle sur une base partagée : identifiants de client tirés au hasard, chaîne vérifiée sur TOUTES les lignes du journal.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) =>
  docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const variables = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n");
  const ligne = variables.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const SECRET = secret();
const DIRECT = cible("postgres", 5432, process.env["SOCLE_PG_DIRECT"]);
const PGBOUNCER = cible("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"]);
const motDePasseDe = (role: string) => createHash("sha256").update(`${SECRET}/${role}`).digest("hex");
const ouverts: { end(): Promise<void> }[] = [];
function pool(voie: { host: string; port: number }, user: string, max: number): pg.Pool {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}

const migration = pool(DIRECT, "console_migration", 3);
const app = pool(PGBOUNCER, "console_app", 10);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const SCHEMA_ESSAI = "essai_audit_ecrire";
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const AJOUTER = "SELECT public.audit_ajouter($1::uuid, $2, $3::public.action_audit, $4, $5, $6::jsonb, $7::jsonb) AS id";
const vide = (v: unknown) => v === null || v === "";

// Nombre de lignes dont le chaînage est faux, sur tout le journal : précédente ≠ empreinte de la ligne d'avant, ou empreinte ≠ sha256(précédente || contenu canonique).
async function lignesCassees(source = "public.journal_audit", cx: { query: pg.Pool["query"] } = migration): Promise<number> {
  const { rows } = await cx.query(`
    SELECT count(*)::int AS n FROM (
      SELECT j.*, lag(j.empreinte) OVER (ORDER BY j.id) AS avant FROM ${source} j
    ) t
    WHERE t.empreinte_precedente IS DISTINCT FROM t.avant
       OR t.empreinte <> encode(sha256(convert_to(coalesce(t.avant, '') || public.audit_contenu(t.id, t.tenant_id, t.acteur, t.action, t.entite, t.entite_id, t.ancienne, t.nouvelle, t.ip, t.cree_le), 'UTF8')), 'hex')`);
  return rows[0]?.["n"] as number;
}
const ecrire = (tenant: string | null, entite: string, entiteId: string, nouvelle: object = { v: 1 }, opts?: { acteur: string; ip?: string }) =>
  tenant === null
    ? app.query(AJOUTER, [null, "equipe-essai", "insertion", entite, entiteId, null, JSON.stringify(nouvelle)])
    : avecClient(app, tenant, (c) => c.query(AJOUTER, [tenant, opts?.acteur ?? "agent-essai", "insertion", entite, entiteId, null, JSON.stringify(nouvelle)]), opts);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA_ESSAI} CASCADE`).catch(() => undefined);
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

describe("journal d'audit chaîné, avec le socle", () => {
  it("[C-028] @isolation UPDATE, DELETE et TRUNCATE du journal sont refusés pour console_app, console_equipe et console_migration", async () => {
    const A = randomUUID();
    await ecrire(A, "essai_refus", "r1");
    const avant = await migration.query("SELECT count(*)::int AS n, max(id)::text AS dernier FROM public.journal_audit");
    // Refus = erreur, ou aucune ligne touchée (la RLS cache toute ligne à une écriture sans politique) ; jamais une ligne modifiée.
    const refuse = async (p: pg.Pool, sql: string) => {
      try {
        const r = await p.query(sql);
        expect(r.rowCount, sql).toBe(0);
      } catch (e) {
        expect(String((e as Error).message), sql).toMatch(/permission denied|ajout seul/);
      }
    };
    for (const p of [app, equipe, migration]) {
      await refuse(p, "UPDATE public.journal_audit SET acteur = 'forge'");
      await refuse(p, "DELETE FROM public.journal_audit");
      await expect(p.query("TRUNCATE public.journal_audit"), "TRUNCATE").rejects.toThrow(/permission denied|ajout seul/);
    }
    // Avec un client actif, la RLS laisse voir la ligne : le refus doit venir du droit (app) ou du déclencheur (migration).
    await expect(avecClient(app, A, (c) => c.query("UPDATE public.journal_audit SET acteur = 'forge'"))).rejects.toThrow(/permission denied/);
    await expect(avecClient(app, A, (c) => c.query("DELETE FROM public.journal_audit"))).rejects.toThrow(/permission denied/);
    const apres = await migration.query("SELECT count(*)::int AS n, max(id)::text AS dernier FROM public.journal_audit WHERE acteur = 'forge'");
    expect(apres.rows[0]?.["n"]).toBe(0);
    const total = await migration.query("SELECT count(*)::int AS n FROM public.journal_audit");
    expect(total.rows[0]?.["n"]).toBeGreaterThanOrEqual(avant.rows[0]?.["n"] as number);
    expect(await lignesCassees()).toBe(0);
  });

  it("[C-028] @isolation le déclencheur refuse UPDATE, DELETE et TRUNCATE au propriétaire, RLS écartée", async () => {
    await ecrire(randomUUID(), "essai_declencheur", "d1");
    // Le propriétaire n'a pas de politique UPDATE ni DELETE : la RLS cacherait les lignes et le déclencheur ne tirerait jamais.
    // Dans une transaction annulée, on écarte la RLS pour que la seule barrière restante soit le déclencheur.
    for (const sql of ["UPDATE public.journal_audit SET acteur = 'forge'", "DELETE FROM public.journal_audit", "TRUNCATE public.journal_audit"]) {
      const c = await migration.connect();
      try {
        await c.query("BEGIN");
        await c.query("ALTER TABLE public.journal_audit NO FORCE ROW LEVEL SECURITY");
        await expect(c.query(sql), sql).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("ajout seul") });
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
    const forge = await migration.query("SELECT count(*)::int AS n FROM public.journal_audit WHERE acteur = 'forge'");
    expect(forge.rows[0]?.["n"]).toBe(0);
    expect(await lignesCassees()).toBe(0);
  });

  it("[C-028] @isolation la chaîne refuse REPEATABLE READ et SERIALIZABLE (photo prise avant le verrou), READ COMMITTED reste accepté", async () => {
    const A = randomUUID();
    for (const niveau of ["REPEATABLE READ", "SERIALIZABLE"]) {
      const c = await app.connect();
      try {
        await c.query(`BEGIN ISOLATION LEVEL ${niveau}`);
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
        await expect(c.query(AJOUTER, [A, "agent-essai", "insertion", "essai_isolation_niveau", niveau, null, null]), niveau).rejects.toThrow(/niveau d'isolation/);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
    await avecClient(app, A, (c) => c.query(AJOUTER, [A, "agent-essai", "insertion", "essai_isolation_niveau", "rc", null, null]));
    const { rows } = await migration.query("SELECT entite_id FROM public.journal_audit WHERE entite = 'essai_isolation_niveau' AND tenant_id = $1", [A]);
    expect(rows.map((r) => r.entite_id)).toEqual(["rc"]);
    expect(await lignesCassees()).toBe(0);
  });

  it("[C-028] @isolation un console_app ne peut pas verrouiller le journal ni bloquer les écritures d'audit", async () => {
    const A = randomUUID();
    const gene = await app.connect();
    try {
      await gene.query("BEGIN");
      await gene.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await gene.query("SELECT count(*) FROM public.journal_audit");
      // Aucun verrou qui bloque les écritures n'est à sa portée : ni verrou de table, ni verrou consultatif à clé connue de l'audit.
      await expect(gene.query("LOCK TABLE public.journal_audit IN SHARE ROW EXCLUSIVE MODE")).rejects.toMatchObject({ code: "42501" });
      await gene.query("ROLLBACK");
      await gene.query("BEGIN");
      await gene.query("SELECT pg_advisory_xact_lock(7410020241028)");
      const debut = Date.now();
      await ecrire(randomUUID(), "essai_verrou", "v1");
      expect(Date.now() - debut).toBeLessThan(4000);
    } finally {
      await gene.query("ROLLBACK").catch(() => undefined);
      gene.release();
    }
  });

  it("[C-028] la vérification de chaîne détecte une rupture, une valeur modifiée et une fourche (chaîne fabriquée)", async () => {
    const c = await migration.connect();
    try {
      await c.query("CREATE TEMP TABLE chaine_essai (LIKE public.journal_audit)");
      let precedente: string | null = null;
      for (let i = 1; i <= 3; i++) {
        const r: pg.QueryResult = await c.query(
          `INSERT INTO chaine_essai (id, acteur, action, entite, cree_le, empreinte_precedente, empreinte)
           SELECT $1::bigint, 'agent-essai', 'insertion', 'essai_chaine', t.ts, $2::text,
                  encode(sha256(convert_to(coalesce($2::text, '') || public.audit_contenu($1::bigint, NULL, 'agent-essai', 'insertion', 'essai_chaine', NULL, NULL, NULL, NULL, t.ts), 'UTF8')), 'hex')
           FROM (SELECT clock_timestamp() AS ts) t RETURNING empreinte`,
          [i, precedente],
        );
        precedente = r.rows[0].empreinte as string;
      }
      const verifier = () => lignesCassees("pg_temp.chaine_essai", c);
      expect(await verifier()).toBe(0);
      await c.query("UPDATE chaine_essai SET acteur = 'forge' WHERE id = 2");
      expect(await verifier()).toBeGreaterThan(0);
      await c.query("UPDATE chaine_essai SET acteur = 'agent-essai' WHERE id = 2");
      expect(await verifier()).toBe(0);
      await c.query("UPDATE chaine_essai SET empreinte_precedente = 'x' WHERE id = 3");
      expect(await verifier()).toBeGreaterThan(0);
      await c.query("UPDATE chaine_essai SET empreinte_precedente = (SELECT empreinte FROM chaine_essai WHERE id = 2) WHERE id = 3");
      expect(await verifier()).toBe(0);
      // Fourche : une ligne qui reprend la précédente d'une autre.
      await c.query("DELETE FROM chaine_essai WHERE id = 2");
      expect(await verifier()).toBeGreaterThan(0);
    } finally {
      await c.query("DROP TABLE IF EXISTS pg_temp.chaine_essai").catch(() => undefined);
      c.release();
    }
  });

  it("[C-028] 50 écritures parallèles à travers PgBouncer donnent une chaîne continue", async () => {
    const A = randomUUID();
    const marque = randomUUID();
    await Promise.all(Array.from({ length: 50 }, (_, i) => ecrire(A, "essai_parallele", `${marque}-${i}`, { i })));
    const { rows } = await migration.query("SELECT count(*)::int AS n FROM public.journal_audit WHERE tenant_id = $1 AND entite = 'essai_parallele'", [A]);
    expect(rows[0]?.["n"]).toBe(50);
    // Chaîne vérifiée sur toutes les lignes (d'autres essais écrivent en même temps) : aucune ligne cassée, aucune précédente en double.
    expect(await lignesCassees()).toBe(0);
    const doubles = await migration.query("SELECT count(*)::int AS n FROM (SELECT empreinte_precedente FROM public.journal_audit WHERE empreinte_precedente IS NOT NULL GROUP BY 1 HAVING count(*) > 1) t");
    expect(doubles.rows[0]?.["n"]).toBe(0);
  });

  it("[C-028] @isolation avec le client A, console_app ne lit ni les lignes de B ni les lignes d'équipe", async () => {
    const A = randomUUID();
    const B = randomUUID();
    const marque = randomUUID();
    await ecrire(A, "essai_lecture", `${marque}-a`);
    await ecrire(B, "essai_lecture", `${marque}-b`);
    await ecrire(null, "essai_lecture", `${marque}-equipe`);
    const vues = await avecClient(app, A, async (c) => (await c.query("SELECT entite_id, tenant_id FROM public.journal_audit WHERE entite_id LIKE $1", [`${marque}%`])).rows);
    expect(vues.map((r) => r.entite_id)).toEqual([`${marque}-a`]);
    expect(vues.every((r) => r.tenant_id === A)).toBe(true);
    // Sans client actif : aucune ligne.
    const sans = await app.query("SELECT count(*)::int AS n FROM public.journal_audit WHERE entite_id LIKE $1", [`${marque}%`]);
    expect(sans.rows[0]?.n).toBe(0);
    // L'équipe lit tout, lignes sans client comprises.
    const toutes = await avecEquipe(equipe, async (c) => (await c.query("SELECT entite_id FROM public.journal_audit WHERE entite_id LIKE $1 ORDER BY id", [`${marque}%`])).rows);
    expect(toutes.map((r) => r.entite_id)).toEqual([`${marque}-a`, `${marque}-b`, `${marque}-equipe`]);
  });

  it("[C-028] @isolation audit_ajouter refuse un client différent du client actif", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await expect(avecClient(app, A, (c) => c.query(AJOUTER, [B, "agent-essai", "insertion", "essai_faux", "f1", null, null]))).rejects.toThrow(/client actif/);
    await expect(avecClient(app, A, (c) => c.query(AJOUTER, [null, "agent-essai", "insertion", "essai_faux", "f2", null, null]))).rejects.toThrow(/client actif/);
    await expect(app.query(AJOUTER, [B, "agent-essai", "insertion", "essai_faux", "f3", null, null])).rejects.toThrow(/client actif/);
    const { rows } = await migration.query("SELECT count(*)::int AS n FROM public.journal_audit WHERE entite = 'essai_faux'");
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("[C-028] console_app n'a pas le droit INSERT direct : une ligne à fausse empreinte est refusée", async () => {
    const A = randomUUID();
    await expect(
      avecClient(app, A, (c) =>
        c.query("INSERT INTO public.journal_audit (tenant_id, acteur, action, entite, empreinte_precedente, empreinte) VALUES ($1, 'forge', 'insertion', 'essai_forge', NULL, 'faux')", [A]),
      ),
    ).rejects.toThrow(/permission denied/);
    // La fonction interne n'est pas non plus ouverte à l'application, ni à l'équipe.
    await expect(avecClient(app, A, (c) => c.query("SELECT public.audit_inserer($1::uuid, 'forge', 'insertion', 'essai_forge', NULL, NULL, NULL, NULL)", [A]))).rejects.toThrow(/permission denied/);
    await expect(equipe.query(AJOUTER, [A, "forge", "insertion", "essai_forge", null, null, null])).rejects.toThrow(/permission denied/);
    const { rows } = await migration.query("SELECT count(*)::int AS n FROM public.journal_audit WHERE entite = 'essai_forge'");
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("[A-178] une ligne écrite par audit_ajouter porte acteur, IP, date et empreinte chaînée", async () => {
    const A = randomUUID();
    const marque = randomUUID();
    await ecrire(A, "essai_champs", marque, { montant: 1234 }, { acteur: "agent-essai", ip: "192.0.2.17" });
    const { rows } = await migration.query(
      "SELECT acteur, action::text AS action, host(ip) AS ip, nouvelle, cree_le > now() - interval '5 minutes' AS recent, empreinte ~ '^[0-9a-f]{64}$' AS hex, empreinte_precedente FROM public.journal_audit WHERE tenant_id = $1 AND entite_id = $2",
      [A, marque],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ acteur: "agent-essai", action: "insertion", ip: "192.0.2.17", nouvelle: { montant: 1234 }, recent: true, hex: true });
    expect(await lignesCassees()).toBe(0);
  });

  it("[A-178] acteur et IP ne passent pas d'une transaction à la suivante à travers PgBouncer", async () => {
    const A = randomUUID();
    const seule = new pg.Pool({ ...PGBOUNCER, user: "console_app", database: "console", password: motDePasseDe("console_app"), max: 1 });
    seule.on("error", () => undefined);
    ouverts.push(seule);
    const lire = (c: pg.PoolClient) => c.query("SELECT current_setting('app.acteur', true) AS acteur, current_setting('app.ip', true) AS ip");
    const dedans = await avecClient(seule, A, async (c) => (await lire(c)).rows[0], { acteur: "agent-essai", ip: "192.0.2.17" });
    expect(dedans).toEqual({ acteur: "agent-essai", ip: "192.0.2.17" });
    // Même connexion cliente, transaction suivante : plus rien.
    for (let i = 0; i < 5; i++) {
      const apres = await avecClient(seule, A, async (c) => (await lire(c)).rows[0]);
      expect(vide(apres.acteur) && vide(apres.ip)).toBe(true);
    }
    const sans = (await seule.query(`SELECT current_setting('app.acteur', true) AS acteur, current_setting('app.ip', true) AS ip`)).rows[0];
    expect(vide(sans.acteur) && vide(sans.ip)).toBe(true);
  });

  it("[A-178] audit_ecrire, attachée à une table, journalise insertion, modification et suppression avec acteur et IP", async () => {
    const A = randomUUID();
    await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA_ESSAI} CASCADE; CREATE SCHEMA ${SCHEMA_ESSAI};
      CREATE TABLE ${SCHEMA_ESSAI}.essai_instances (id integer PRIMARY KEY, tenant_id uuid NOT NULL, etat text NOT NULL);
      CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON ${SCHEMA_ESSAI}.essai_instances FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire();
      GRANT USAGE ON SCHEMA ${SCHEMA_ESSAI} TO console_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ${SCHEMA_ESSAI}.essai_instances TO console_app`);
    await avecClient(
      app,
      A,
      async (c) => {
        await c.query(`INSERT INTO ${SCHEMA_ESSAI}.essai_instances VALUES (7, $1, 'active')`, [A]);
        await c.query(`UPDATE ${SCHEMA_ESSAI}.essai_instances SET etat = 'pause' WHERE id = 7`);
        await c.query(`DELETE FROM ${SCHEMA_ESSAI}.essai_instances WHERE id = 7`);
      },
      { acteur: "agent-essai", ip: "192.0.2.18" },
    );
    const { rows } = await migration.query("SELECT action::text AS action, acteur, host(ip) AS ip, entite, entite_id, ancienne, nouvelle FROM public.journal_audit WHERE tenant_id = $1 ORDER BY id", [A]);
    expect(rows.map((r) => r.action)).toEqual(["insertion", "modification", "suppression"]);
    expect(rows.every((r) => r.acteur === "agent-essai" && r.ip === "192.0.2.18" && r.entite === "essai_instances" && r.entite_id === "7")).toBe(true);
    expect(rows[0]).toMatchObject({ ancienne: null, nouvelle: { etat: "active" } });
    expect(rows[1]).toMatchObject({ ancienne: { etat: "active" }, nouvelle: { etat: "pause" } });
    expect(rows[2]).toMatchObject({ ancienne: { etat: "pause" }, nouvelle: null });
    expect(await lignesCassees()).toBe(0);
  });

  it("[A-119] @isolation journal_audit appliqué : invariants C5 sans écart sur le schéma public", async () => {
    const tables = (await migration.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => String(r.tablename));
    expect(tables).toContain("journal_audit");
    const ecarts = await controlerInvariants(requete, "console", OPTIONS);
    // Les essais d'isolation laissent des schémas volontairement non conformes dans console : seules les tables de public comptent (hors tables d'essai jetables).
    const publics = ecarts.filter((e) => tables.includes(e.objet.split(".")[0] ?? "") && !e.objet.startsWith("essai_"));
    expect(publics).toEqual([]);
  });
});
