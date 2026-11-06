import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { nomBaseDe, nomsRoles } from "../provisionnement/etapes-base.js";
import { limitesPg, validiteRolePg } from "./identifiants-base.js";

// T4-39b-2, essais sur un VRAI PostgreSQL (même principe que isolation-et-coupure.int.test.ts ; COURTIER_INT_PG="hote:port:mot-de-passe" pour un serveur déjà lancé).
// Sans démon Docker ces essais ne tournent pas ici : ils sont écrits pour le job socle-integration de la CI. Hors de portée : PgBouncer.
const racine = (c: string) => fileURLToPath(new URL(`../../../../${c}`, import.meta.url));
const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const lances: string[] = [];
const ouverts: { end(): Promise<void> }[] = [];
afterAll(async () => {
  for (const o of ouverts) await o.end().catch(() => undefined);
  for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ }
});
interface Serveur { host: string; port: number; mdp: string }
async function lancer(): Promise<Serveur> {
  const externe = process.env["COURTIER_INT_PG"];
  if (externe) { const [host, port, mdp] = externe.split(":"); return { host: host!, port: Number(port), mdp: mdp! }; }
  const mdp = randomBytes(16).toString("hex");
  const compose = lireYaml(readFileSync(racine("ops/socle/compose.postgres.yml"), "utf8")) as unknown as { services: Record<string, { image: string }> };
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
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
let S: Serveur;
let admin: pg.Client;
const A = randomUUID();
const B = randomUUID();
const MDP = { A: `essai-${randomBytes(8).toString("hex")}`, B: `essai-${randomBytes(8).toString("hex")}` };
async function creerClient(t: string, mdp: string): Promise<void> {
  const base = nomBaseDe(t);
  const r = nomsRoles(t);
  await admin.query(`CREATE ROLE "${r.proprietaire}" NOLOGIN`);
  await admin.query(`CREATE ROLE "${r.lecture}" LOGIN NOINHERIT CONNECTION LIMIT 2 PASSWORD ${lit(mdp)} VALID UNTIL '2099-01-01'`);
  await admin.query(`ALTER ROLE "${r.lecture}" SET statement_timeout = '5s'`);
  await admin.query(`CREATE ROLE "${r.app}" LOGIN NOINHERIT CONNECTION LIMIT 8 PASSWORD ${lit(mdp)}`);
  await admin.query(`CREATE DATABASE "${base}" OWNER "${r.proprietaire}"`);
  await admin.query(`REVOKE ALL ON DATABASE "${base}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${base}" TO "${r.app}", "${r.lecture}"`);
  const c = await ouvrir(S, "postgres", S.mdp, base);
  await c.query(`CREATE TABLE public.relances (id int, texte text)`);
  await c.query(`INSERT INTO public.relances VALUES (1, 'relance')`);
  await c.query(`GRANT USAGE ON SCHEMA public TO "${r.app}", "${r.lecture}"`);
  await c.query(`GRANT SELECT ON public.relances TO "${r.lecture}"`);
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.relances TO "${r.app}"`);
}
beforeAll(async () => {
  S = await lancer();
  admin = await ouvrir(S, "postgres", S.mdp, "postgres");
  await creerClient(A, MDP.A);
  await creerClient(B, MDP.B);
}, 180_000);

describe("remise de _lecture sur un vrai PostgreSQL", () => {
  it("[C-624] @isolation l'identifiant de lecture remis pour une tâche de A ne se connecte pas à cli_<B>", async () => {
    const r = nomsRoles(A).lecture;
    expect((await (await ouvrir(S, r, MDP.A, nomBaseDe(A))).query("SELECT 1")).rowCount).toBe(1);
    await expect(ouvrir(S, r, MDP.A, nomBaseDe(B))).rejects.toThrow();
  });

  it("[C-624] le rôle remis pour la lecture est cli_<id>_lecture et INSERT/UPDATE/DELETE y échouent", async () => {
    const c = await ouvrir(S, nomsRoles(A).lecture, MDP.A, nomBaseDe(A));
    expect((await c.query("SELECT texte FROM public.relances")).rowCount).toBe(1);
    for (const ordre of ["INSERT INTO public.relances VALUES (2, 'x')", "UPDATE public.relances SET texte = 'x'", "DELETE FROM public.relances"]) await expect(c.query(ordre), ordre).rejects.toThrow(/permission denied/i);
  });

  it("[A-417] les lectures pg_roles du courtier voient le statement_timeout, la CONNECTION LIMIT et le VALID UNTIL de _lecture", async () => {
    const sql = { requete: async (t: string, v?: unknown[]) => (await admin.query(t, v)).rows as never };
    const r = nomsRoles(A).lecture;
    await expect(limitesPg(sql)(r)).resolves.toEqual({ statementTimeout: true, connectionLimit: 2 });
    expect((await validiteRolePg(sql)(r)) instanceof Date).toBe(true);
  });

  it("[A-170] une lecture de l'exécuteur et une lecture de la console du même client tiennent sous CONNECTION LIMIT 2", async () => {
    const r = nomsRoles(A).lecture;
    const executeur = await ouvrir(S, r, MDP.A, nomBaseDe(A));
    const console_ = await ouvrir(S, r, MDP.A, nomBaseDe(A));
    expect((await executeur.query("SELECT 1")).rowCount).toBe(1);
    expect((await console_.query("SELECT 1")).rowCount).toBe(1);
    // Une troisième session dépasse la limite : refus (et non relèvement discret de la limite).
    await expect(ouvrir(S, r, MDP.A, nomBaseDe(A))).rejects.toThrow(/too many connections/i);
  });
});
