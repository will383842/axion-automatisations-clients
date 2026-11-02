import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { avecClient } from "../db/client-actif.js";
import { enregistrerPlan, ErreurPlan, preparerPlan } from "./plan.js";

// Plan commercial calculé (T2-08) contre un vrai PostgreSQL : socle lancé par ops/socle/lancer.sh (job socle-integration). Instances d'essai à l'état pause, montants fictifs.
// Les essais tournent en parallèle sur une base partagée : identifiants de client tirés au hasard.
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
const app = new pg.Pool({ ...PGBOUNCER, user: "console_app", database: "console", password: motDePasseDe("console_app"), max: 10, connectionTimeoutMillis: 10_000 });
app.on("error", () => undefined);
ouverts.push(app);
afterAll(async () => {
  for (const p of ouverts) await p.end();
});
const migration = new pg.Pool({ ...DIRECT, user: "console_migration", database: "console", password: motDePasseDe("console_migration"), max: 2 });
migration.on("error", () => undefined);
ouverts.push(migration);

const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const ins = (tenant: string, table: string, valeurs: Record<string, unknown>) => {
  const v = { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return avecClient(app, tenant, (c) => c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v)), APPELANT).then(() => v.id);
};
// Un client complet : organisation, une instance à l'état pause (aucun contrat de sous-traitance requis) et des conditions qui fournissent toutes les valeurs.
async function client(engagement: number, formule = "abonnement") {
  const A = randomUUID();
  await ins(A, "organisations", { id: A, console_client_id: A, raison_sociale: "Lemoine Rénovation" });
  const instance = await ins(A, "instances", { organisation_id: A, code_automatisation: "relance-devis", formule, environnement: "test", etat: "pause" });
  const condition = (type: string, valeur: unknown) => ins(A, "conditions_commerciales", { organisation_id: A, type, valeur: JSON.stringify(valeur), source: "client", auteur: "agent-essai" });
  await condition("frais", { frais_mise_en_place_centimes: 100, tarif_mensuel_centimes: 200 });
  await condition("engagement", { engagement_mois: engagement, maintenance_incluse_mois: 0, suite_maintenance: "arret" });
  await condition("periode", { periode_facturation_mois: 1, mode_avance: "aucune" });
  return { A, instance };
}

describe("plan commercial calculé, contre PostgreSQL", () => {
  it("[A-119] @isolation preparerPlan du client A ne lit aucune condition de B", async () => {
    const a = await client(6);
    const b = await client(99);
    const plan = await avecClient(app, a.A, (c) => preparerPlan(c, a.A, a.instance as string, {}), APPELANT);
    expect(plan.engagementMois).toBe(6);
    expect(plan.sources.engagement).toBe("client");
    // L'instance de B n'existe pas pour A : refus, jamais un plan calculé avec les conditions de B.
    await expect(avecClient(app, a.A, (c) => preparerPlan(c, a.A, b.instance as string, {}), APPELANT)).rejects.toMatchObject({ motif: "instance_introuvable" });
    // Un tenant passé en argument qui n'est pas celui de la transaction ne lit rien.
    await expect(avecClient(app, a.A, (c) => preparerPlan(c, b.A, b.instance as string, {}), APPELANT)).rejects.toBeInstanceOf(ErreurPlan);
  });

  it("[A-006] deux instances du même client portent deux formules différentes", async () => {
    const a = await client(6);
    const seconde = await ins(a.A, "instances", { organisation_id: a.A, code_automatisation: "relance-devis", formule: "achat", environnement: "test", etat: "pause" });
    const [p1, p2] = await avecClient(app, a.A, async (c) => [await preparerPlan(c, a.A, a.instance as string, {}), await preparerPlan(c, a.A, seconde as string, {})] as const, APPELANT);
    expect([p1.formule, p2.formule]).toEqual(["abonnement", "achat"]);
  });

  it("[C-138] @argent enregistrerPlan écrit une seule ligne, avec ses sources, et refuse un second plan", async () => {
    const a = await client(12);
    const instance = a.instance as string;
    await avecClient(app, a.A, async (c) => enregistrerPlan(c, a.A, await preparerPlan(c, a.A, instance, {}), "agent-essai", "mise en place"), APPELANT);
    const { rows } = await migration.query("SELECT frais_mise_en_place_ht_centimes AS f, prix_recurrent_mensuel_ht_centimes AS p, source_engagement AS s, auteur FROM plans_commerciaux WHERE tenant_id = $1 AND instance_id = $2", [a.A, instance]);
    expect(rows).toEqual([{ f: "100", p: "200", s: "client", auteur: "agent-essai" }]);
    await expect(avecClient(app, a.A, async (c) => enregistrerPlan(c, a.A, await preparerPlan(c, a.A, instance, {}), "agent-essai", "second"), APPELANT)).rejects.toMatchObject({ motif: "plan_existant" });
  });
});
