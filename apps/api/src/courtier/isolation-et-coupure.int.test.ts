import { execFileSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { nomBaseDe, nomsRoles } from "../provisionnement/etapes-base.js";
import { definitionRoleHumain } from "./acces-humain.js";
import { adminRotationPg, sessionsPg } from "./rotation.js";

// T2-36b, essais sur un VRAI PostgreSQL lancé par l'essai (même image que le socle, mots de passe tirés au lancement). Ce que l'essai exerce pour de bon :
// les ordres SQL de creation_statements et revocation_statements de definitionRoleHumain (OpenBao les joue tels quels), adminRotationPg et sessionsPg.
// Hors de portée ici : PgBouncer (KILL et RESUME vont à un bouchon qui les note) et OpenBao (il ne fait que substituer {{name}}, {{password}} et {{expiration}}, ce que fait l'essai).
// Variable facultative COURTIER_INT_PG="hote:port:mot-de-passe" : un PostgreSQL déjà lancé (compte postgres) au lieu de Docker.
const racineDepot = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const lances: string[] = [];
const ouverts: { end(): Promise<void> }[] = [];
afterAll(async () => {
  for (const o of ouverts) await o.end().catch(() => undefined);
  for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ }
});

interface Serveur { host: string; port: number; mdp: string }
async function lancerPostgres(): Promise<Serveur> {
  const externe = process.env["COURTIER_INT_PG"];
  if (externe) {
    const [host, port, mdp] = externe.split(":");
    return { host: host!, port: Number(port), mdp: mdp! };
  }
  const mdp = randomBytes(16).toString("hex");
  const compose = lireYaml(readFileSync(racineDepot("ops/socle/compose.postgres.yml"), "utf8")) as unknown as { services: Record<string, { image: string }> };
  const id = docker("run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${mdp}`, compose.services["postgres"]!.image);
  lances.push(id);
  const host = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  for (let i = 0; ; i++) {
    const c = new pg.Client({ host, user: "postgres", password: mdp, database: "postgres" });
    try { await c.connect(); await c.end(); return { host, port: 5432, mdp }; } catch { /* démarrage */ }
    if (i > 90) throw new Error("PostgreSQL de test non démarré");
    await new Promise((ok) => setTimeout(ok, 500));
  }
}
const ouvrir = async (s: Serveur, user: string, password: string, database: string): Promise<pg.Client> => {
  const c = new pg.Client({ host: s.host, port: s.port, user, password, database, connectionTimeoutMillis: 10_000 });
  c.on("error", () => undefined);
  await c.connect();
  ouverts.push(c);
  return c;
};
const refuse = async (s: Serveur, user: string, password: string, database: string): Promise<string> => {
  try { await (await ouvrir(s, user, password, database)).query("SELECT 1"); } catch (e) { return (e as Error).message; }
  throw new Error("connexion acceptée");
};
// Empreinte SCRAM-SHA-256 d'un mot de passe (le serveur n'en reçoit jamais d'autre forme).
function scram(mdp: string): string {
  const sel = randomBytes(16);
  const sale = pbkdf2Sync(mdp, sel, 4096, 32, "sha256");
  const cle = createHmac("sha256", sale).update("Client Key").digest();
  const stockee = createHash("sha256").update(cle).digest("base64");
  const serveur = createHmac("sha256", sale).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${sel.toString("base64")}$${stockee}:${serveur}`;
}

let S: Serveur;
let admin: pg.Client;
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const A = randomUUID();
const B = randomUUID();
const MDP_APP = `essai-${randomBytes(8).toString("hex")}`;
// Un client : sa base, ses trois rôles (comme le provisionnement), une table lisible par _lecture.
async function creerClient(tenantId: string): Promise<void> {
  const base = nomBaseDe(tenantId);
  const r = nomsRoles(tenantId);
  await admin.query(`CREATE ROLE "${r.proprietaire}" NOLOGIN`);
  await admin.query(`CREATE ROLE "${r.lecture}" LOGIN NOINHERIT CONNECTION LIMIT 2`);
  await admin.query(`CREATE ROLE "${r.app}" LOGIN NOINHERIT CONNECTION LIMIT 8 PASSWORD ${lit(MDP_APP)}`);
  await admin.query(`CREATE DATABASE "${base}" OWNER "${r.proprietaire}"`);
  await admin.query(`REVOKE ALL ON DATABASE "${base}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${base}" TO "${r.app}", "${r.lecture}"`);
  const c = await ouvrir(S, "postgres", S.mdp, base);
  await c.query(`CREATE TABLE public.relances (id int, texte text)`);
  await c.query(`INSERT INTO public.relances VALUES (1, ${lit(`relance de ${base}`)})`);
  await c.query(`GRANT USAGE ON SCHEMA public TO "${r.app}", "${r.lecture}"`);
  await c.query(`GRANT SELECT ON public.relances TO "${r.lecture}"`);
}
// OpenBao substitue {{name}}, {{password}} et {{expiration}} puis joue chaque ordre : l'essai fait de même.
const jouer = async (ordres: string[], nom: string, mdp: string) => {
  for (const o of ordres) await admin.query(o.replaceAll("{{name}}", nom).replaceAll("{{password}}", mdp).replaceAll("{{expiration}}", new Date(Date.now() + 3_600_000).toISOString()));
};
const humain = async (tenantId: string) => {
  const nom = `v-essai-${randomBytes(4).toString("hex")}`;
  const mdp = randomBytes(12).toString("hex");
  await jouer(definitionRoleHumain(tenantId).creation_statements, nom, mdp);
  return { nom, mdp };
};
const existe = async (nom: string) => (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [nom])).rowCount === 1;

beforeAll(async () => {
  S = await lancerPostgres();
  admin = await ouvrir(S, "postgres", S.mdp, "postgres");
  await creerClient(A);
  await creerClient(B);
}, 180_000);

describe("accès humain et coupure des sessions sur un vrai PostgreSQL", () => {
  it("[A-211] l'identifiant dynamique du client A lit la base de A, est refusé sur la base de B et ne peut rien écrire", async () => {
    const { nom, mdp } = await humain(A);
    const surA = await ouvrir(S, nom, mdp, nomBaseDe(A));
    expect((await surA.query("SELECT texte FROM public.relances")).rows[0]).toEqual({ texte: `relance de ${nomBaseDe(A)}` });
    await expect(surA.query("INSERT INTO public.relances VALUES (2, 'x')")).rejects.toThrow();
    expect(await refuse(S, nom, mdp, nomBaseDe(B))).toMatch(/permission denied|not permitted/i);
  });

  it("[A-211] fin de bail : le rôle perd LOGIN d'abord, sa session ouverte est coupée, sa reconnexion est refusée et le rôle disparaît", async () => {
    const { nom, mdp } = await humain(A);
    const session = await ouvrir(S, nom, mdp, nomBaseDe(A));
    await session.query("SELECT 1");
    const ordres = definitionRoleHumain(A).revocation_statements;
    await jouer(ordres, nom, mdp);
    await expect(session.query("SELECT 1")).rejects.toThrow();
    await refuse(S, nom, mdp, nomBaseDe(A));
    expect(await existe(nom)).toBe(false);
  });

  it("[A-211] si la suppression du rôle échoue, le rôle n'a plus le droit de se connecter : aucune reconnexion jusqu'à l'expiration", async () => {
    const { nom, mdp } = await humain(A);
    const session = await ouvrir(S, nom, mdp, nomBaseDe(A));
    await session.query("SELECT 1");
    // Les trois premiers ordres passent, le DROP ROLE n'est jamais joué : le pire cas de l'audit.
    const ordres = definitionRoleHumain(A).revocation_statements;
    await jouer(ordres.slice(0, -1), nom, mdp);
    expect(await existe(nom)).toBe(true);
    await expect(session.query("SELECT 1")).rejects.toThrow();
    expect(await refuse(S, nom, mdp, nomBaseDe(A))).toMatch(/not permitted to log in|password authentication failed/i);
    await admin.query(`DROP ROLE "${nom}"`);
  });

  it("[A-169] une session ouverte avant la rotation immédiate est coupée ; l'ancien mot de passe est refusé ensuite, le nouveau accepté, et les sessions humaines du client sont coupées aussi", async () => {
    const r = nomsRoles(A);
    const avant = await ouvrir(S, r.app, MDP_APP, nomBaseDe(A));
    await avant.query("SELECT 1");
    const h = await humain(A);
    const humaine = await ouvrir(S, h.nom, h.mdp, nomBaseDe(A));
    await humaine.query("SELECT 1");
    const autre = await ouvrir(S, nomsRoles(B).app, MDP_APP, nomBaseDe(B));
    // Changement du mot de passe puis coupure, dans l'ordre de la rotation immédiate (le bouchon de PgBouncer note KILL puis RESUME).
    const nouveau = `essai-${randomBytes(8).toString("hex")}`;
    await adminRotationPg({ requete: async (t, v) => (await admin.query(t, v)).rows as never }).changerMotDePasse(r.app, scram(nouveau), 2, new Date(Date.now() + 60 * 86_400_000));
    const bouncer: string[] = [];
    await sessionsPg({ requete: async (t, v) => (await admin.query(t, v)).rows as never }, { requete: async (t) => { bouncer.push(t); return [] as never; } }).couper(nomBaseDe(A), r.app);
    expect(bouncer).toEqual([`KILL ${nomBaseDe(A)}`, `RESUME ${nomBaseDe(A)}`]);
    await expect(avant.query("SELECT 1")).rejects.toThrow();
    await expect(humaine.query("SELECT 1")).rejects.toThrow();
    expect((await autre.query("SELECT 1")).rowCount).toBe(1);
    expect(await refuse(S, r.app, MDP_APP, nomBaseDe(A))).toMatch(/password authentication failed/i);
    expect((await (await ouvrir(S, r.app, nouveau, nomBaseDe(A))).query("SELECT 1")).rowCount).toBe(1);
  });

  it("[C-035] le gel coupe aussi les sessions de cli_<id>_lecture", async () => {
    const r = nomsRoles(A);
    const mdpLecture = `essai-${randomBytes(8).toString("hex")}`;
    await admin.query(`ALTER ROLE "${r.lecture}" PASSWORD ${lit(mdpLecture)}`);
    const lecture = await ouvrir(S, r.lecture, mdpLecture, nomBaseDe(A));
    await lecture.query("SELECT 1");
    const autre = await ouvrir(S, nomsRoles(B).app, MDP_APP, nomBaseDe(B));
    await sessionsPg({ requete: async (t, v) => (await admin.query(t, v)).rows as never }, { requete: async () => [] as never }).couper(nomBaseDe(A), r.app);
    await expect(lecture.query("SELECT 1")).rejects.toThrow();
    expect((await autre.query("SELECT 1")).rowCount).toBe(1);
  });
});
