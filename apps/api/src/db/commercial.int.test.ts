import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, EXCEPTIONS_UNICITE, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Tables du plan commercial (T2-04) : abonnements, plans, phases, échéances, conditions. Socle lancé par ops/socle/lancer.sh (job socle-integration).
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
function pool(voie: { host: string; port: number }, user: string, max: number): pg.Pool {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}

const migration = pool(DIRECT, "console_migration", 3);
const app = pool(PGBOUNCER, "console_app", 40);
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const equipe = pool(PGBOUNCER, "console_equipe", 3);

// Les écritures auditées passent par le verrou du journal : une attente trop longue (55P03) est rejouée.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if ((e as { code?: string }).code !== "55P03" || essai >= 4) throw e;
    }
  }
}
const inserer = (tenant: string, table: string, valeurs: Record<string, unknown>) => {
  const v = { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return ecrire(app, tenant, async (c) => (await c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v))).rows[0] as Record<string, unknown>, APPELANT);
};
const creerOrg = (id: string) => inserer(id, "organisations", { id, console_client_id: id, raison_sociale: "Lemoine Rénovation" });
const creerInstance = (A: string) => inserer(A, "instances", { organisation_id: A, code_automatisation: "relance-devis", formule: "abonnement", environnement: "test" });
const SOURCES = Object.fromEntries(["formule", "frais_mise_en_place", "prix_recurrent_mensuel", "periode_facturation", "mode_avance", "maintenance_incluse", "suite_maintenance", "engagement"].map((v) => [`source_${v}`, "grille"]));
// Valeurs fictives (jamais un prix réel) : 100, 200 et 300 centimes.
const plan = (A: string, instance: unknown, extra: Record<string, unknown> = {}) =>
  inserer(A, "plans_commerciaux", { instance_id: instance, formule: "abonnement", frais_mise_en_place_centimes: 100, prix_recurrent_mensuel_centimes: 200, periode_facturation_mois: 1, mode_avance: "aucune", maintenance_incluse_mois: 0, suite_maintenance: "arret", engagement_mois: 0, ...SOURCES, ...extra });
const nouveauPlan = async (A: string) => plan(A, (await creerInstance(A))["id"]);
const echeance = (A: string, planId: unknown, extra: Record<string, unknown> = {}) =>
  inserer(A, "echeances", { plan_id: planId, debut_periode: "2026-01-01", fin_periode: "2026-02-01", montant_ht_centimes: 200, ...extra });

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

describe("plan commercial, avec le socle", { timeout: 60_000 }, () => {
  it("[A-041] @argent un plan commercial lié à une instance : un seul plan par instance, rangé sur l'instance", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    const p = await plan(A, instance["id"]);
    expect(p).toMatchObject({ prix_recurrent_mensuel_centimes: "200", periode_facturation_mois: 1 });
    await expect(plan(A, instance["id"])).rejects.toMatchObject({ code: "23505" });
    await ecrire(app, A, (c) => c.query("UPDATE instances SET plan_commercial = $2 WHERE id = $1", [instance["id"], p["id"]]), APPELANT);
    expect((await ecrire(app, A, (c) => c.query("SELECT plan_commercial FROM instances WHERE id = $1", [instance["id"]]))).rows[0]?.plan_commercial).toBe(p["id"]);
    await expect(ecrire(app, A, (c) => c.query("UPDATE instances SET plan_commercial = $2 WHERE id = $1", [instance["id"], randomUUID()]), APPELANT)).rejects.toMatchObject({ code: "23503" });
  });

  it("[A-143] @argent une valeur du plan sans sa source, ou avec une source inconnue, est refusée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    await expect(plan(A, instance["id"], { source_engagement: null })).rejects.toMatchObject({ code: "23502" });
    await expect(plan(A, instance["id"], { source_engagement: "devine" })).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-006] en V1, la formule achat est refusée par la base", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const formule of ["achat", "installation_maintenance"]) await expect(plan(A, (await creerInstance(A))["id"], { formule })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-125] un abonnement refuse une période hors 1, 6, 12 ; un plan aussi", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const abo = (extra: Record<string, unknown>) => inserer(A, "abonnements", { organisation_id: A, debut: "2026-01-01", quotas: JSON.stringify({ messages: 10 }), periode_facturation_mois: 12, mode_avance: "aucune", ...extra });
    await expect(abo({})).resolves.toMatchObject({ periode_facturation_mois: 12 });
    await expect(abo({ periode_facturation_mois: 3 })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ acompte_points_de_base: 2000.5 })).rejects.toMatchObject({ code: "22P02" });
    await expect(abo({ acompte_points_de_base: 10001 })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ fin: "2025-12-31" })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ quotas: JSON.stringify([1]) })).rejects.toMatchObject({ code: "23514" });
    await expect(plan(A, (await creerInstance(A))["id"], { periode_facturation_mois: 3 })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-144] deux phases d'un plan avec le même ordre : la seconde est refusée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const phase = (extra: Record<string, unknown>) => inserer(A, "phases_plan", { plan_id: p["id"], ordre: 1, debut: "2026-01-01", nature: "recurrente", montant_centimes: 200, periode_facturation_mois: 1, ...extra });
    await phase({});
    await expect(phase({})).rejects.toMatchObject({ code: "23505" });
    await expect(phase({ ordre: 2 })).resolves.toMatchObject({ ordre: 2 });
    await expect(phase({ ordre: 3, montant_centimes: -1 })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-145] @argent 10 insertions parallèles d'une échéance pour la même période : une seule ligne", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const resultats = await Promise.allSettled(Array.from({ length: 10 }, () => echeance(A, p["id"])));
    expect(resultats.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Table auditée : une attente du verrou du journal (55P03) reste possible pour un perdant ; la preuve est « une seule ligne ».
    for (const r of resultats) if (r.status === "rejected") expect(["23505", "55P03"]).toContain((r.reason as { code?: string }).code);
    expect((await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM echeances WHERE plan_id = $1", [p["id"]]))).rows[0]?.n).toBe(1);
    await expect(echeance(A, p["id"], { debut_periode: "2026-02-01", fin_periode: "2026-03-01" })).resolves.toBeTruthy();
  });

  it("[A-145] @argent un montant non entier, négatif ou au-delà de 2^53 est refusé ; le montant d'une échéance ne se modifie pas", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    await expect(echeance(A, p["id"], { montant_ht_centimes: -1 })).rejects.toMatchObject({ code: "23514" });
    await expect(echeance(A, p["id"], { montant_ht_centimes: 12.5 })).rejects.toMatchObject({ code: "22P02" });
    await expect(echeance(A, p["id"], { montant_ht_centimes: "9007199254740992" })).rejects.toMatchObject({ code: "23514" });
    await expect(echeance(A, p["id"], { fin_periode: "2026-01-01" })).rejects.toMatchObject({ code: "23514" });
    await expect(plan(A, (await creerInstance(A))["id"], { prix_recurrent_mensuel_centimes: -5 })).rejects.toMatchObject({ code: "23514" });
    const e = await echeance(A, p["id"], { debut_periode: "2026-05-01", fin_periode: "2026-06-01" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE echeances SET montant_ht_centimes = 1 WHERE id = $1", [e["id"]]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE echeances SET statut = 'payee' WHERE id = $1", [e["id"]]), APPELANT)).rejects.toMatchObject({ code: "23514" });
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM echeances WHERE id = $1", [e["id"]]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-146] une condition du client porte la source client, son auteur et ses dates", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const cond = (extra: Record<string, unknown>) => inserer(A, "conditions_commerciales", { organisation_id: A, type: "remise", valeur: JSON.stringify({ points_de_base: 500 }), source: "client", auteur: "agent-essai", valide_du: "2026-01-01", ...extra });
    await expect(cond({})).resolves.toMatchObject({ source: "client", auteur: "agent-essai" });
    await expect(cond({ source: "defaut" })).rejects.toMatchObject({ code: "23514" });
    await expect(cond({ auteur: " " })).rejects.toMatchObject({ code: "23514" });
    await expect(cond({ auteur: null })).rejects.toMatchObject({ code: "23502" });
    await expect(cond({ valide_au: "2025-12-31" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-146] @isolation console_app ne modifie pas les conditions par défaut et ne lit ni ne modifie celles de B", async () => {
    const [A, B] = [randomUUID(), randomUUID()];
    await Promise.all([creerOrg(A), creerOrg(B)]);
    const cond = await inserer(B, "conditions_commerciales", { organisation_id: B, type: "garantie", valeur: "{}", source: "client", auteur: "agent-essai" });
    await ecrire(app, A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM conditions_commerciales WHERE tenant_id = $1", [B])).rows[0]?.n).toBe(0);
    });
    expect((await ecrire(app, A, (c) => c.query("UPDATE conditions_commerciales SET valide_au = '2030-01-01' WHERE id = $1", [cond["id"]]), APPELANT)).rowCount).toBe(0);
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO conditions_commerciales (id, tenant_id, organisation_id, type, valeur, source, auteur) VALUES ($1, $2, $2, 'frais', '{}'::jsonb, 'client', 'x')", [randomUUID(), B]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM conditions_commerciales WHERE tenant_id = $1", [B]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE conditions_par_defaut SET valeur = '{}'::jsonb"), APPELANT)).rejects.toMatchObject({ code: "42501" });
    // L'équipe lit en lecture seule : aucune écriture sur les conditions.
    expect((await equipe.query("SELECT 1 FROM conditions_commerciales WHERE id = $1", [cond["id"]])).rowCount).toBe(1);
    await expect(equipe.query("UPDATE conditions_commerciales SET valide_au = '2030-01-01'")).rejects.toMatchObject({ code: "42501" });
    // Un plan de B ne se lie pas à une instance de A (clé étrangère composée).
    const instanceA = await creerInstance(A);
    await expect(plan(B, instanceA["id"])).rejects.toMatchObject({ code: "23503" });
  });

  it("[A-163] @isolation @argent la même période d'échéance chez deux clients est permise, la seconde chez le même client est refusée, sans erreur révélant une ligne de B", async () => {
    const [A, B] = [randomUUID(), randomUUID()];
    await Promise.all([creerOrg(A), creerOrg(B)]);
    const [pA, pB] = [await nouveauPlan(A), await nouveauPlan(B)];
    await echeance(B, pB["id"]);
    await expect(echeance(A, pA["id"])).resolves.toBeTruthy();
    await expect(echeance(A, pA["id"])).rejects.toMatchObject({ code: "23505", constraint: "echeances_tenant_id_plan_id_debut_periode_unique" });
    // Le plan de B n'est pas visible de A : insérer chez A une échéance sur le plan de B donne une clé étrangère, jamais un 23505 sur la ligne de B.
    const erreur = await echeance(A, pB["id"]).catch((e) => e as { code?: string; detail?: string });
    expect(erreur).toMatchObject({ code: "23503" });
    expect(JSON.stringify(erreur)).not.toContain(B);
  });

  it("[A-119] toutes les migrations appliquées, les invariants C5 ne trouvent aucun écart (dont montants en entiers)", async () => {
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
    const { rows } = await migration.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY 1", [["abonnements", "plans_commerciaux", "phases_plan", "echeances", "conditions_commerciales"]]);
    expect(rows).toHaveLength(5);
    expect(EXCEPTIONS_UNICITE).toEqual([]);
  });
});
