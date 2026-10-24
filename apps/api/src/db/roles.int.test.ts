import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";

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
async function connexionRefusee(voie: Voie, user: string, database: string): Promise<boolean> {
  const c = new pg.Client(options(voie, user, database));
  c.on("error", () => undefined);
  try {
    await c.connect();
    await c.end();
    return false;
  } catch {
    return true;
  }
}
const BASES = ["console", "moteur"] as const;
const ROLES = (b: string) => ({ proprietaire: `${b}_proprietaire`, migration: `${b}_migration`, app: `${b}_app`, equipe: `${b}_equipe` });

describe("bases et connexions", () => {
  it("[A-049] PostgreSQL 16 répond à travers PgBouncer en mode transaction et l'extension pg_partman est installée", async () => {
    const clients = await Promise.all(Array.from({ length: 12 }, () => client("pgbouncer", "console_app", "console")));
    const version = await lignes(clients[0] as pg.Client, "SELECT current_setting('server_version_num')::int AS v");
    expect(version[0]?.["v"]).toBeGreaterThanOrEqual(160000);
    expect(version[0]?.["v"]).toBeLessThan(170000);
    // 12 clients connectés en même temps passent par moins de connexions serveur : le pool est en mode transaction.
    const pids = new Set<unknown>();
    for (const c of clients) pids.add((await lignes(c, "SELECT pg_backend_pid() AS pid"))[0]?.["pid"]);
    expect(pids.size).toBeLessThan(clients.length);
    for (const b of BASES) {
      const equipe = await client("direct", `${b}_equipe`, b);
      const extensions = await lignes(equipe, "SELECT extname FROM pg_extension ORDER BY extname");
      expect(extensions.map((e) => e["extname"])).toContain("pg_partman");
    }
  });

  it("[A-186] les quatre bases existent et le rôle console_app ne se connecte pas à moteur", async () => {
    const equipe = await client("direct", "console_equipe", "console");
    const bases = (await lignes(equipe, "SELECT datname FROM pg_database")).map((l) => l["datname"]);
    for (const b of ["console", "moteur", "keycloak", "passerelle_ia"]) expect(bases).toContain(b);
    for (const voie of ["direct", "pgbouncer"] as const) {
      for (const autre of ["moteur", "keycloak", "passerelle_ia", "postgres", "template1"]) {
        expect(await connexionRefusee(voie, "console_app", autre), `${voie} → ${autre}`).toBe(true);
      }
    }
    for (const b of BASES) {
      for (const [nom, r] of Object.entries(ROLES(b))) {
        if (nom === "proprietaire") continue; // sans connexion : le droit CONNECT du propriétaire de la base n'est pas un accès
        for (const base of ["console", "moteur", "keycloak", "passerelle_ia", "postgres", "template1"]) {
          const attendu = base === b;
          const droit = await lignes(equipe, "SELECT has_database_privilege($1, $2, 'CONNECT') AS ok", [r, base]);
          expect(droit[0]?.["ok"], `${r} sur ${base}`).toBe(attendu);
        }
      }
    }
    const aclPublic = await lignes(equipe, "SELECT d.datname FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datallowconn AND a.grantee = 0 AND a.privilege_type IN ('CONNECT', 'TEMPORARY')");
    expect(aclPublic).toEqual([]);
  });
});

describe("rôles", () => {
  it("[A-165] les rôles ont les attributs prévus : propriétaire sans connexion, aucun superutilisateur ni BYPASSRLS", async () => {
    const equipe = await client("direct", "console_equipe", "console");
    for (const b of BASES) {
      for (const [nom, r] of Object.entries(ROLES(b))) {
        const [a] = await lignes(equipe, "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1", [r]);
        expect(a, r).toEqual({ rolcanlogin: nom !== "proprietaire", rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
      }
      expect(await connexionRefusee("direct", `${b}_proprietaire`, b)).toBe(true);
    }
  });

  it("[A-165] console_app ne possède aucun schéma ni table ; un ALTER TABLE par console_app est refusé", async () => {
    const migration = pool("direct", "console_migration", "console", 1);
    const app = pool("direct", "console_app", "console", 1);
    await migration.query("DROP SCHEMA IF EXISTS essai_roles CASCADE");
    try {
      await migration.query("CREATE SCHEMA essai_roles; CREATE TABLE essai_roles.t (id bigint PRIMARY KEY, tenant_id uuid NOT NULL); GRANT USAGE ON SCHEMA essai_roles TO console_app; GRANT ALL ON essai_roles.t TO console_app");
      const possedes = await lignes(app, "SELECT d.classid::regclass::text AS catalogue FROM pg_shdepend d JOIN pg_roles r ON r.oid = d.refobjid WHERE d.deptype = 'o' AND r.rolname = 'console_app'");
      expect(possedes).toEqual([]);
      const proprio = await lignes(app, "SELECT pg_get_userbyid(relowner) AS p FROM pg_class WHERE oid = 'essai_roles.t'::regclass");
      expect(proprio[0]?.["p"]).toBe("console_proprietaire");
      expect(await codeRefus(app, "ALTER TABLE essai_roles.t ADD COLUMN x int")).toBe("42501");
      expect(await codeRefus(app, "DROP TABLE essai_roles.t")).toBe("42501");
      expect(await codeRefus(app, "ALTER TABLE essai_roles.t DISABLE ROW LEVEL SECURITY")).toBe("42501");
      // Un GRANT sans option de transmission ne fait qu'un avertissement : on vérifie qu'il n'a rien ouvert.
      await app.query("GRANT ALL ON essai_roles.t TO PUBLIC");
      const ouvert = await lignes(app, "SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'essai_roles.t'::regclass AND a.grantee = 0");
      expect(ouvert).toEqual([]);
    } finally {
      await migration.query("DROP SCHEMA IF EXISTS essai_roles CASCADE");
    }
  });

  it("[A-165] console_app ne peut pas devenir un autre rôle (SET ROLE, SET SESSION AUTHORIZATION)", async () => {
    const app = await client("direct", "console_app", "console");
    for (const cible of ["console_proprietaire", "console_migration", "console_equipe", "moteur_app", "postgres"]) {
      expect(await codeRefus(app, `SET ROLE ${cible}`), cible).toBe("42501");
      expect(await codeRefus(app, `SET SESSION AUTHORIZATION ${cible}`), cible).toBe("42501");
    }
    const equipe = await client("direct", "console_equipe", "console");
    for (const r of ["console_app", "console_proprietaire", "console_migration"]) {
      for (const membre of ["console_app", "console_equipe"]) {
        const [l] = await lignes(equipe, "SELECT pg_has_role($1, $2, 'MEMBER') AS ok", [membre, r]);
        expect(l?.["ok"] && membre !== r, `${membre} membre de ${r}`).toBe(false);
      }
    }
  });

  it("[A-163] aucun rôle de l'application n'est superutilisateur, BYPASSRLS ni membre d'un tel rôle (invariants C5)", async () => {
    for (const b of BASES) {
      const equipe = pool("direct", `${b}_equipe`, b, 1);
      const requete: Requete = async (sql) => (await lignes(equipe, `SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`))[0]?.["r"] as Record<string, unknown>[];
      const ecarts = await controlerInvariants(requete, b, { rolesApplication: /^(console|moteur)_(app|equipe|migration)$/ });
      expect(ecarts.filter((e) => e.regle === "role_contourne_rls")).toEqual([]);
    }
  });

  it("[A-165] aucune fonction SECURITY DEFINER n'est joignable par console_app ni console_equipe ; une fonction créée par la migration n'est pas ouverte à tous", async () => {
    const migration = pool("direct", "console_migration", "console", 1);
    await migration.query("DROP SCHEMA IF EXISTS essai_roles CASCADE");
    try {
      await migration.query("CREATE SCHEMA essai_roles; GRANT USAGE ON SCHEMA essai_roles TO console_app, console_equipe; CREATE FUNCTION essai_roles.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
      for (const r of ["console_app", "console_equipe", "moteur_app"]) {
        const joignables = await lignes(migration, `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND has_schema_privilege($1, n.oid, 'USAGE') AND has_function_privilege($1, p.oid, 'EXECUTE')`, [r]);
        expect(joignables, r).toEqual([]);
      }
      const app = pool("direct", "console_app", "console", 1);
      expect(await codeRefus(app, "SELECT essai_roles.f()")).toBe("42501");
    } finally {
      await migration.query("DROP SCHEMA IF EXISTS essai_roles CASCADE");
    }
  });

  it("[A-165] console_app ne crée rien : ni table dans public, ni schéma, ni fonction, ni table temporaire ; search_path fixé", async () => {
    const app = await client("direct", "console_app", "console");
    for (const sql of ["CREATE TABLE public.piege (id int)", "CREATE SCHEMA piege", "CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql AS 'SELECT NULL::timestamptz'", "CREATE TEMP TABLE piege (id int)", "CREATE TYPE public.piege AS ENUM ('a')"]) {
      expect(await codeRefus(app, sql), sql).toBe("42501");
    }
    expect((await lignes(app, "SHOW search_path"))[0]?.["search_path"]).toBe("public");
    const droits = await lignes(app, "SELECT has_schema_privilege('console_app', 'public', 'CREATE') AS c, has_database_privilege('console_app', 'console', 'CREATE') AS d, has_database_privilege('console_app', 'console', 'TEMPORARY') AS t");
    expect(droits[0]).toEqual({ c: false, d: false, t: false });
  });

  it("[A-165] aucune extension ne s'ajoute par console_app ; la liste des extensions est fermée ; aucun rôle prédéfini dangereux", async () => {
    for (const b of BASES) {
      const app = await client("direct", `${b}_app`, b);
      for (const extension of ["dblink", "pg_trgm"]) expect(await codeRefus(app, `CREATE EXTENSION ${extension}`), extension).toBe("42501");
      expect(await codeRefus(app, "COPY (SELECT 1) TO PROGRAM 'true'")).toBe("42501");
      const extensions = await lignes(app, "SELECT extname FROM pg_extension ORDER BY extname");
      expect(extensions.map((e) => e["extname"])).toEqual(["pg_partman", "plpgsql"]);
      for (const [, r] of Object.entries(ROLES(b))) {
        for (const predefini of ["pg_read_server_files", "pg_write_server_files", "pg_execute_server_program", "pg_read_all_data", "pg_write_all_data", "pg_monitor", "pg_signal_backend", "pg_checkpoint", "pg_create_subscription"]) {
          const [l] = await lignes(app, "SELECT pg_has_role($1, $2, 'MEMBER') AS ok", [r, predefini]);
          expect(l?.["ok"], `${r} membre de ${predefini}`).toBe(false);
        }
      }
    }
  });

  it("[A-165] droits par défaut : un objet créé par la migration n'est ouvert ni à PUBLIC ni à console_app tant qu'on ne l'accorde pas", async () => {
    const migration = pool("direct", "console_migration", "console", 1);
    const app = pool("direct", "console_app", "console", 1);
    await migration.query("DROP SCHEMA IF EXISTS essai_roles CASCADE");
    try {
      await migration.query("CREATE SCHEMA essai_roles; GRANT USAGE ON SCHEMA essai_roles TO console_app; CREATE TABLE essai_roles.t (id int, tenant_id uuid NOT NULL); CREATE FUNCTION essai_roles.f() RETURNS int LANGUAGE sql AS 'SELECT 1'");
      expect(await codeRefus(app, "SELECT * FROM essai_roles.t")).toBe("42501");
      expect(await codeRefus(app, "SELECT essai_roles.f()")).toBe("42501");
      const publics = await lignes(migration, `SELECT 'public' AS ou FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname = 'public' AND a.grantee = 0
        UNION ALL SELECT 'defaut' FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee IN (0, 'console_app'::regrole::oid)`);
      expect(publics).toEqual([]);
    } finally {
      await migration.query("DROP SCHEMA IF EXISTS essai_roles CASCADE");
    }
  });

  it("[A-165] ni le superutilisateur, ni le propriétaire, ni le rôle de migration ne se connectent à travers PgBouncer", async () => {
    for (const user of ["postgres", "console_proprietaire", "console_migration", "moteur_migration"]) {
      expect(await connexionRefusee("pgbouncer", user, user.startsWith("moteur") ? "moteur" : "console"), user).toBe(true);
    }
  });
});
