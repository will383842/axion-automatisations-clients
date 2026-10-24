import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient, avecEquipe } from "./client-actif.js";

// Tests contre le socle lancé par ops/socle/lancer.sh (job socle-integration).
// Les services ne publient aucun port : on joint leur adresse sur le réseau interne (docker inspect), jamais écrite dans un fichier.
// Hors CI, SOCLE_PG_DIRECT et SOCLE_PG_PGBOUNCER (« hote:port ») et SOCLE_PG_MOT_DE_PASSE remplacent la lecture de Docker.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) =>
  docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur(service)), port };
}
function motDePasse(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const variables = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n");
  const ligne = variables.find((l) => l.startsWith("POSTGRES_PASSWORD="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("POSTGRES_PASSWORD=".length);
}

const DIRECT = cible("postgres", 5432, process.env["SOCLE_PG_DIRECT"]);
const PGBOUNCER = cible("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"]);
const MOT_DE_PASSE = motDePasse();
const ouverts: { end(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

type Voie = "direct" | "pgbouncer";
const options = (voie: Voie, user: string, database: string) => ({
  ...(voie === "direct" ? DIRECT : PGBOUNCER), user, database, password: MOT_DE_PASSE, connectionTimeoutMillis: 10_000,
});
function pool(voie: Voie, user: string, database: string, max = 4): pg.Pool {
  const p = new pg.Pool({ ...options(voie, user, database), max });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}
async function client(voie: Voie, user: string, database: string): Promise<pg.Client> {
  const c = new pg.Client(options(voie, user, database));
  c.on("error", () => undefined);
  ouverts.push(c);
  await c.connect();
  return c;
}
const lignes = async (p: pg.Pool | pg.Client, sql: string, valeurs: unknown[] = []) => (await p.query(sql, valeurs)).rows as Record<string, unknown>[];
// Code SQLSTATE de l'échec attendu (42501 = droit refusé) ; échoue si la requête réussit.
async function codeRefus(p: pg.Pool | pg.Client, sql: string): Promise<string> {
  try {
    await p.query(sql);
  } catch (e) {
    return String((e as { code?: string }).code);
  }
  throw new Error(`la requête aurait dû être refusée : ${sql}`);
}
const BASES = ["console", "moteur"] as const;
const MODELE = readFileSync(new URL("../../../../ops/socle/postgres/modele-politique-rls.sql", import.meta.url), "utf8");
const CLIENT_A = "6f1c3a52-8d1e-4b7a-9c20-3e5d7a1b0c11";
const CLIENT_B = "b2d94e07-51aa-4c3e-8f61-0a7c9d2e4b55";
const CREER = "CREATE TABLE essai_isolation.dossiers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, libelle text NOT NULL)";

// Applique le modèle de politique RLS à une table, comme le fera une migration du lot 2 : paramètres fixés dans la transaction, puis le fichier.
async function appliquerModele(migration: pg.Pool, base: string, table: string): Promise<void> {
  const c = await migration.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('modele.schema', 'essai_isolation', true), set_config('modele.table', $1, true), set_config('modele.app', $2, true), set_config('modele.equipe', $3, true)", [table, `${base}_app`, `${base}_equipe`]);
    await c.query(MODELE);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const requeteDe = (p: pg.Pool): Requete => async (sql) => (await lignes(p, `SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`))[0]?.["r"] as Record<string, unknown>[];
const vide = (v: unknown) => v === null || v === "";

describe.each(BASES)("isolation entre clients sur la base %s", (b) => {
  // Sur la base moteur, les mêmes tests prouvent A-166.
  const id = (exigence: string) => (b === "moteur" ? "A-166" : exigence);
  const migration = pool("direct", `${b}_migration`, b, 2);
  const app = pool("pgbouncer", `${b}_app`, b, 10);
  const equipe = pool("pgbouncer", `${b}_equipe`, b, 4);

  const nettoyer = () => migration.query("DROP SCHEMA IF EXISTS essai_isolation CASCADE");
  const ecrire = (tenant: string, libelle: string) => avecClient(app, tenant, (c) => c.query("INSERT INTO essai_isolation.dossiers (tenant_id, libelle) VALUES ($1, $2)", [tenant, libelle]));
  beforeAll(async () => {
    await nettoyer();
    await migration.query(`CREATE SCHEMA essai_isolation; ${CREER}`);
    await appliquerModele(migration, b, "dossiers");
    await ecrire(CLIENT_A, "a1");
    await ecrire(CLIENT_A, "a2");
    await ecrire(CLIENT_B, "b1");
    await ecrire(CLIENT_B, "b2");
  });
  afterAll(nettoyer);

  it(`[${id("A-163")}] @isolation la table d'essai conforme passe les invariants C5 sans écart ; une table sans FORCE est signalée`, async () => {
    const options = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
    // Le schéma partman (outil de partition) n'est pas une table métier : seul le schéma d'essai est jugé.
    const ecarts = (await controlerInvariants(requeteDe(migration), b, options)).filter((e) => e.objet.startsWith("essai_isolation.") || e.regle === "role_contourne_rls");
    expect(ecarts).toEqual([]);
    await migration.query(`CREATE TABLE essai_isolation.sans_force (id bigint PRIMARY KEY, tenant_id uuid NOT NULL); ALTER TABLE essai_isolation.sans_force ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON essai_isolation.sans_force USING (tenant_id = current_setting('app.tenant_id')::uuid)`);
    const apres = await controlerInvariants(requeteDe(migration), b, options);
    expect(apres).toContainEqual({ regle: "force_rls_absent", objet: "essai_isolation.sans_force" });
    await migration.query("DROP TABLE essai_isolation.sans_force");
  });

  it(`[${id("A-164")}] @isolation sans client actif, ${b}_app lit 0 ligne, même avec une valeur vide ; le propriétaire lui-même en lit 0 (FORCE)`, async () => {
    expect(await lignes(app, "SELECT * FROM essai_isolation.dossiers")).toEqual([]);
    expect(await lignes(migration, "SELECT * FROM essai_isolation.dossiers")).toEqual([]);
    const vides = await avecClient(app, CLIENT_A, async (c) => {
      await c.query("SELECT set_config('app.tenant_id', '', true)");
      return (await c.query("SELECT * FROM essai_isolation.dossiers")).rows;
    });
    expect(vides).toEqual([]);
  });

  it(`[${id("A-164")}] @isolation une valeur de client qui n'est pas un UUID fait échouer la requête au lieu de montrer des lignes`, async () => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', 'pas-un-uuid', true)");
      await expect(c.query("SELECT * FROM essai_isolation.dossiers")).rejects.toMatchObject({ code: "22P02" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it(`[${id("A-164")}] @isolation avec le client A, ne lit et n'écrit que A (écrire pour B est refusé par WITH CHECK)`, async () => {
    const lus = await avecClient(app, CLIENT_A, async (c) => (await c.query("SELECT tenant_id, libelle FROM essai_isolation.dossiers ORDER BY libelle")).rows);
    expect(lus).toEqual([{ tenant_id: CLIENT_A, libelle: "a1" }, { tenant_id: CLIENT_A, libelle: "a2" }]);
    await expect(avecClient(app, CLIENT_A, (c) => c.query("INSERT INTO essai_isolation.dossiers (tenant_id, libelle) VALUES ($1, 'pour-b')", [CLIENT_B]))).rejects.toMatchObject({ code: "42501" });
    await expect(avecClient(app, CLIENT_A, (c) => c.query("UPDATE essai_isolation.dossiers SET tenant_id = $1 WHERE libelle = 'a1'", [CLIENT_B]))).rejects.toMatchObject({ code: "42501" });
    const touche = await avecClient(app, CLIENT_A, async (c) => [
      (await c.query("UPDATE essai_isolation.dossiers SET libelle = 'pirate' WHERE tenant_id = $1", [CLIENT_B])).rowCount,
      (await c.query("DELETE FROM essai_isolation.dossiers WHERE tenant_id = $1", [CLIENT_B])).rowCount,
    ]);
    expect(touche).toEqual([0, 0]);
  });

  it(`[${id("A-164")}] @isolation 50 transactions alternées A et B en parallèle à travers PgBouncer : aucune ligne croisée`, async () => {
    const resultats = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const moi = i % 2 === 0 ? CLIENT_A : CLIENT_B;
        return avecClient(app, moi, async (c) => {
          await c.query("SELECT pg_sleep($1)", [Math.random() / 50]);
          const lignesVues = (await c.query("SELECT DISTINCT tenant_id FROM essai_isolation.dossiers")).rows as { tenant_id: string }[];
          const actif = (await c.query("SELECT current_setting('app.tenant_id') AS t")).rows[0] as { t: string };
          return { moi, vus: lignesVues.map((l) => l.tenant_id), actif: actif.t };
        });
      }),
    );
    for (const r of resultats) {
      expect(r.vus).toEqual([r.moi]);
      expect(r.actif).toBe(r.moi);
    }
  });

  it(`[${id("A-164")}] @isolation après la fin d'une transaction, la connexion recyclée n'a plus de client actif`, async () => {
    for (let i = 0; i < 30; i++) {
      await avecClient(app, i % 2 === 0 ? CLIENT_A : CLIENT_B, async () => undefined);
      expect(await lignes(app, "SELECT * FROM essai_isolation.dossiers")).toEqual([]);
      expect(vide((await lignes(app, "SELECT current_setting('app.tenant_id', true) AS t"))[0]?.["t"])).toBe(true);
    }
  });

  it(`[${id("A-164")}] @isolation un SET de session fait par erreur ne reste pas sur la connexion serveur rendue au pool`, async () => {
    const fautif = await client("pgbouncer", `${b}_app`, b);
    await fautif.query(`SET app.tenant_id = '${CLIENT_A}'`);
    const autres = await Promise.all(Array.from({ length: 8 }, () => client("pgbouncer", `${b}_app`, b)));
    for (let tour = 0; tour < 5; tour++) {
      for (const c of [fautif, ...autres]) {
        expect(vide((await lignes(c, "SELECT current_setting('app.tenant_id', true) AS t"))[0]?.["t"])).toBe(true);
        expect(await lignes(c, "SELECT * FROM essai_isolation.dossiers")).toEqual([]);
      }
    }
  });

  it(`[${id("A-164")}] ${b}_equipe lit A et B, sans pouvoir écrire`, async () => {
    const vus = await avecEquipe(equipe, async (c) => (await c.query("SELECT DISTINCT tenant_id FROM essai_isolation.dossiers ORDER BY tenant_id")).rows.map((r: { tenant_id: string }) => r.tenant_id));
    expect(vus).toEqual([CLIENT_A, CLIENT_B]);
    for (const sql of ["INSERT INTO essai_isolation.dossiers (tenant_id, libelle) VALUES (gen_random_uuid(), 'x')", "UPDATE essai_isolation.dossiers SET libelle = 'x'", "DELETE FROM essai_isolation.dossiers", "TRUNCATE essai_isolation.dossiers"]) {
      expect(await codeRefus(equipe, sql), sql).toBe("42501");
      await expect(avecEquipe(equipe, (c) => c.query(sql)), sql).rejects.toThrow();
    }
    // Un client actif fixé par erreur ne change rien pour l'équipe : elle voit tout, pas seulement ce client.
    const avecFausseValeur = await avecClient(equipe, CLIENT_A, async (c) => (await c.query("SELECT DISTINCT tenant_id FROM essai_isolation.dossiers")).rows.length);
    expect(avecFausseValeur).toBe(2);
  });

  it(`[${id("A-163")}] @isolation le modèle se rejoue sans effet : deux politiques, aucun écart, aucun droit en plus`, async () => {
    await appliquerModele(migration, b, "dossiers");
    await appliquerModele(migration, b, "dossiers");
    const politiques = await lignes(migration, "SELECT policyname, roles::text AS roles FROM pg_policies WHERE schemaname = 'essai_isolation' AND tablename = 'dossiers' ORDER BY policyname");
    expect(politiques).toEqual([{ policyname: "isolation_client", roles: `{${b}_app}` }, { policyname: "lecture_equipe", roles: `{${b}_equipe}` }]);
    const droitsDe = async (role: string) => {
      const sortie: string[] = [];
      for (const d of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        if ((await lignes(migration, "SELECT has_table_privilege($1, 'essai_isolation.dossiers', $2) AS ok", [role, d]))[0]?.["ok"]) sortie.push(d);
      }
      return sortie;
    };
    expect(await droitsDe(`${b}_app`)).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    expect(await droitsDe(`${b}_equipe`)).toEqual(["SELECT"]);
  });
});
