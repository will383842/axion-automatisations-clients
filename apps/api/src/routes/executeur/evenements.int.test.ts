import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../../db/client-actif.js";
import { migrer } from "../../db/migrer.js";
import { journalEchecs } from "../../provisionnement/journal-echecs.js";
import { depotExecutionsPg, idExecution } from "../../executeur/ranger-evenements.js";

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
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => { await Promise.all(ouverts.map((o) => o.end().catch(() => undefined))); });

const creerOrg = (A: string) => avecClient(app, A, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')", [A]), APPELANT);
// Depuis 0019 (ADR 0111) console_app ne fournit pas `id` (42501) : la base le génère, on le relit.
const creerInstance = (A: string) =>
  avecClient(app, A, async (c) => (await c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'relance-devis', 'abonnement', 'test', 'pause') RETURNING id", [A])).rows[0]?.["id"] as string, APPELANT);
const lignes = (A: string) => avecClient(app, A, async (c) => (await c.query("SELECT id, statut, duree_ms, elements_traites, code_erreur, auteur FROM executions")).rows as { id: string; statut: string; duree_ms: string | null; elements_traites: number; code_erreur: string | null; auteur: string }[], APPELANT);

describe("rangement des événements sur la vraie base (T4-23)", () => {
  it("[A-343] debut puis fin rangent une ligne terminée ; le même paquet rejoué n'en crée aucune de plus", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const inst = await creerInstance(A);
    const depot = depotExecutionsPg(app, "cellule-essai", async () => undefined);
    const id = idExecution(inst, "exec-1");
    for (let i = 0; i < 2; i++) {
      await depot.debut(A, inst, id);
      await depot.fin(A, inst, id, { dureeMs: 1200, elements: 4, jetons: 300, coutIaMicroCentimes: 15 });
    }
    const l = await lignes(A);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id, statut: "reussie", elements_traites: 4, auteur: "cellule:cellule-essai" });
  });

  it("[A-343] deux rangements simultanés du même debut ne créent qu'une ligne executions", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const inst = await creerInstance(A);
    const depot = depotExecutionsPg(app, "cellule-essai", async () => undefined);
    const id = idExecution(inst, "exec-concurrent");
    const n = 10;
    await Promise.all(Array.from({ length: n }, async () => {
      await depot.debut(A, inst, id);
      await depot.fin(A, inst, id, { dureeMs: 1200, elements: 4, jetons: 300, coutIaMicroCentimes: 15 });
    }));
    const l = await lignes(A);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id, statut: "reussie", elements_traites: 4 });
    const cout = await avecClient(app, A, async (c) => (await c.query("SELECT SUM(cout_micro_centimes)::text AS total FROM executions")).rows[0]?.["total"] as string, APPELANT);
    expect(cout).toBe("15"); // coût non doublé
  });

  it("[A-343] debut puis erreur range un échec avec son code", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const inst = await creerInstance(A);
    const depot = depotExecutionsPg(app, "cellule-essai", async () => undefined);
    const id = idExecution(inst, "exec-2");
    await depot.debut(A, inst, id);
    await depot.erreur(A, inst, id, "reglage_manquant");
    expect((await lignes(A))[0]).toMatchObject({ statut: "echec", code_erreur: "reglage_manquant" });
  });

  it("[A-346] @isolation une ligne rangée pour le client A n'est jamais visible du client B", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const inst = await creerInstance(A);
    const depot = depotExecutionsPg(app, "cellule-essai", async () => undefined);
    await depot.debut(A, inst, idExecution(inst, "exec-3"));
    expect(await lignes(B)).toHaveLength(0);
    // Écrire sous le mauvais client échoue (clé étrangère et RLS) : jamais de ligne chez B pour l'instance de A.
    await expect(depot.debut(B, inst, idExecution(inst, "exec-4"))).rejects.toThrow();
    expect(await lignes(B)).toHaveLength(0);
  });
});
