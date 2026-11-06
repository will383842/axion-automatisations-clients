import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signalerRenouvellementsProches } from "../crm/renouvellements.ts";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Tâche de nuit des renouvellements (T2-18) jouée sur la vraie base. Socle lancé par ops/socle/lancer.sh (job socle-integration).
// Les dates sont relatives au jour de la base (Europe/Paris) : l'essai ne dépend pas de la date du jour. Identifiants de client tirés au hasard (base partagée).
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
const app = pool(PGBOUNCER, "console_app", 10);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

const SOURCES = Object.fromEntries(["formule", "frais_mise_en_place", "prix_recurrent_mensuel", "periode_facturation", "mode_avance", "maintenance_incluse", "suite_maintenance", "engagement"].map((v) => [`source_${v}`, "grille"]));
const creerOrg = (A: string) => avecClient(app, A, (c) => c.query("INSERT INTO organisations (tenant_id, id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Lemoine Rénovation')", [A]), APPELANT);
// Instance de l'organisation, avec un plan commercial « arret » ou « reconduction » (valeurs fictives, jamais un prix réel).
async function creerInstanceAvecPlan(A: string, suite: "arret" | "reconduction"): Promise<void> {
  await avecClient(app, A, async (c) => {
    const planId = randomUUID();
    // T2-52 : l'id de l'instance est tiré par la base (console_app ne le fournit plus).
    const instance = (await c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'relance-devis', 'abonnement', 'test', 'pause') RETURNING id", [A])).rows[0]?.["id"] as string;
    const colonnes = { id: planId, tenant_id: A, instance_id: instance, frais_mise_en_place_ht_centimes: 100, prix_recurrent_mensuel_ht_centimes: 200, periode_facturation_mois: 1, mode_avance: "aucune", maintenance_incluse_mois: 0, suite_maintenance: suite, engagement_mois: 0, ...SOURCES, auteur: APPELANT.acteur };
    await c.query(`INSERT INTO plans_commerciaux (${Object.keys(colonnes).join(", ")}) VALUES (${Object.keys(colonnes).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(colonnes));
    await c.query("UPDATE instances SET plan_commercial = $2 WHERE tenant_id = $1 AND id = $3", [A, planId, instance]);
  }, APPELANT);
}
// Abonnement dont la fin est à `jours` jours du jour de la base (Europe/Paris) ; null = sans date de fin.
const creerAbonnement = (A: string, jours: number | null) =>
  avecClient(app, A, (c) => c.query(
    `INSERT INTO abonnements (tenant_id, id, organisation_id, debut, fin, periode_facturation_mois, auteur)
     VALUES ($1, $2, $1, (now() AT TIME ZONE 'Europe/Paris')::date - 400, CASE WHEN $3::int IS NULL THEN NULL ELSE (now() AT TIME ZONE 'Europe/Paris')::date + $3::int END, 1, $4)`,
    [A, randomUUID(), jours, APPELANT.acteur]), APPELANT);
// Émetteur espion : enregistre les dates signalées.
async function signaler(A: string): Promise<string[]> {
  return avecClient(app, A, async (c) => {
    const dates: string[] = [];
    await signalerRenouvellementsProches(c, { renouvellementProche: async (_i, date) => { dates.push(date); return { eventId: "essai", nouveau: true }; } }, A);
    return dates;
  }, APPELANT);
}
const jourPlus = async (A: string, jours: number) => avecClient(app, A, async (c) => (await c.query("SELECT to_char((now() AT TIME ZONE 'Europe/Paris')::date + $1::int, 'YYYY-MM-DD') AS j", [jours])).rows[0]?.["j"] as string);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("renouvellements à 30 jours, avec le socle", { timeout: 60_000 }, () => {
  it("[C-346] un abonnement reconduit, qui finit dans 30 jours, est signalé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await creerInstanceAvecPlan(A, "reconduction");
    await creerAbonnement(A, 30);
    expect(await signaler(A)).toEqual([await jourPlus(A, 30)]);
  });

  it("[C-346] un abonnement dont le plan de l'organisation s'arrête (« arrêt ») n'est pas signalé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await creerInstanceAvecPlan(A, "arret");
    await creerAbonnement(A, 30);
    expect(await signaler(A)).toEqual([]);
  });

  it("[C-346] organisation mixte (un plan « arrêt », un plan « reconduction ») : signalé, car l'abonnement ne dit pas de quel plan il dépend (V1, ADR 0059)", async () => {
    const mixte = randomUUID();
    await creerOrg(mixte);
    await creerInstanceAvecPlan(mixte, "arret");
    await creerInstanceAvecPlan(mixte, "reconduction");
    await creerAbonnement(mixte, 30);
    expect(await signaler(mixte)).toEqual([await jourPlus(mixte, 30)]);
  });

  it("[C-346] @bornes fin au jour J exclue, à J + 30 incluse, à J + 31 exclue, passée exclue, sans date exclue", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const jours of [0, 1, 30, 31, -5, null]) await creerAbonnement(A, jours);
    expect(await signaler(A)).toEqual([await jourPlus(A, 1), await jourPlus(A, 30)]);
  });

  it("[C-346] @isolation la tâche d'un client ne voit jamais les abonnements d'un autre client", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await creerAbonnement(B, 10);
    expect(await signaler(A)).toEqual([]);
    expect(await signaler(B)).toHaveLength(1);
  });
});
