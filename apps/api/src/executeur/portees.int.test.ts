import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../db/client-actif.js";
import { migrer } from "../db/migrer.js";
import { journalEchecs } from "../provisionnement/journal-echecs.js";
import { attribuerCellule, resoudreInstance } from "./portees.js";

// Essai réel de portees.ts (dette T4-21-dette-portees-reel) : socle lancé par ops/socle/lancer.sh (job socle-integration), sous console_equipe puis console_app.
// Aucun Docker en cloud : ce fichier n'a pas été joué hors CI. Les échecs sont écrits par writeSync(2, …) (journal-echecs.ts).
journalEchecs(import.meta.url);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  return { host: docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const ligne = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n").find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
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
const app = pool(PGBOUNCER, "console_app", 10);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => { await Promise.all(ouverts.map((o) => o.end().catch(() => undefined))); });

const creerOrg = (A: string) => avecClient(app, A, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')", [A]), APPELANT);
const creerInstance = (A: string, id: string = randomUUID()) =>
  avecClient(app, A, async (c) => { await c.query("INSERT INTO instances (id, tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $2, $2, 'relance-devis', 'abonnement', 'test', 'pause')", [id, A]); return id; }, APPELANT);
async function creerCellule(): Promise<string> {
  const code = `cellule-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const c = await equipe.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', 'agent-essai', true)");
    await c.query("INSERT INTO cellules (code, adresse_interne, mode, capacite, nombre_instances, version_image, etat) VALUES ($1, $2, 'mutualise', 50, 0, '1.0.0', 'active')", [code, `${code}.interne.test`]);
    await c.query("COMMIT");
  } finally { c.release(); }
  return code;
}

describe("portees.ts avec le socle", { timeout: 90_000 }, () => {
  it("[C-017] resoudreInstance sous console_equipe rend le client, l'état, l'arrêt des envois et la version d'une instance", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    await expect(resoudreInstance(equipe, id)).resolves.toEqual({ tenantId: A, celluleCode: null, etat: "pause", arretEnvois: false, version: 0 });
    await expect(resoudreInstance(equipe, randomUUID())).resolves.toBeNull();
  });

  it("[C-017] @isolation attribuerCellule sous RLS : le client de l'instance l'attribue, un autre client ne change aucune ligne, la version monte de 1", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const id = await creerInstance(A);
    const code = await creerCellule();
    await expect(attribuerCellule(app, { tenantId: B, instanceId: id, cellule: code }, APPELANT)).resolves.toBe(false);
    await expect(resoudreInstance(equipe, id)).resolves.toMatchObject({ celluleCode: null, version: 0 });
    await expect(attribuerCellule(app, { tenantId: A, instanceId: id, cellule: code }, APPELANT)).resolves.toBe(true);
    await expect(resoudreInstance(equipe, id)).resolves.toMatchObject({ tenantId: A, celluleCode: code, version: 1 });
  });

  it("[C-017] @isolation deux lignes pour un même id (deux clients) : resoudreInstance rend null, sans distinction", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const id = await creerInstance(A);
    // Tant que instances.id n'est pas unique seul (dette ouverte, ADR de l'architecte attendu), le second client peut reprendre le même id.
    await creerInstance(B, id);
    await expect(resoudreInstance(equipe, id)).resolves.toBeNull();
  });
});
