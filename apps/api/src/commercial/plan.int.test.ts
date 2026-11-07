import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { automatisationFictive, GRILLE_FICTIVE } from "../catalogue/fixtures.js";
import { avecClient } from "../db/client-actif.js";
import { PLATEFORME_ID } from "../db/schema/aides.js";
import { migrer } from "../db/migrer.js";
import { lirePlanClient } from "./plan-client.js";
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
const migration = new pg.Pool({ ...DIRECT, user: "console_migration", database: "console", password: motDePasseDe("console_migration"), max: 2 });
migration.on("error", () => undefined);
ouverts.push(migration);
// Le catalogue commun (automatisations, grilles de prix, préréglages) s'écrit par l'équipe : le rôle de migration n'a aucune politique d'écriture (RLS forcée).
const equipe = new pg.Pool({ ...PGBOUNCER, user: "console_equipe", database: "console", password: motDePasseDe("console_equipe"), max: 3, connectionTimeoutMillis: 10_000 });
equipe.on("error", () => undefined);
ouverts.push(equipe);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
// Un essai en échec est écrit sur la sortie d'erreur : lisible dans le journal du job (le rapport JSON n'est pas publié).
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const ins = (tenant: string, table: string, valeurs: Record<string, unknown>) => {
  // T2-52 : l'id d'une instance est tiré par la base (console_app ne le fournit plus), relu par RETURNING id.
  const v: Record<string, unknown> = table === "instances" ? { tenant_id: tenant, ...valeurs } : { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return avecClient(app, tenant, (c) => c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")})${table === "instances" ? " RETURNING id" : ""}`, Object.values(v)), APPELANT).then((r) => (table === "instances" ? r.rows[0]?.["id"] : v["id"]));
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

// Écriture de l'équipe : transaction avec l'acteur du journal ; le verrou du journal peut faire attendre (55P03), la mise en place est rejouée.
async function ecrireEquipe<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let essai = 1; ; essai++) {
    const c = await equipe.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.acteur', 'agent-essai', true), set_config('lock_timeout', '5s', true)");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 4) throw e;
    } finally {
      c.release();
    }
  }
}
const lettres = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const donneesMetier = (engagement: number) => ({ engagement_mois: engagement, suite_maintenance: "arret", periode_facturation_mois: 1, mode_avance: "aucune" });
// Une automatisation avec sa grille (frais et mensuel fictifs) et deux versions publiées du préréglage d'un métier : 1 (engagement 24) et 2 (engagement 36).
async function catalogue(formulesActives: string[]) {
  const metier = (await avecClient(app, randomUUID(), (c) => c.query("SELECT id FROM metiers LIMIT 1"), APPELANT)).rows[0]?.["id"] as string;
  return ecrireEquipe(async (c) => {
    const a = (await c.query("INSERT INTO automatisations (code, nom, fonction, description) VALUES ($1, $2, $3, $4) RETURNING id", [`${lettres(5)}-${String(Math.floor(Math.random() * 900) + 100)}`, ...(["nom", "fonction", "description"] as const).map((k) => String(automatisationFictive("X-100")[k]))])).rows[0]?.["id"] as string;
    await c.query("INSERT INTO grilles_prix (automatisation_id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur) VALUES ($1, $2, $3, $4, 3, $5, 'agent-essai')", [a, JSON.stringify(formulesActives), GRILLE_FICTIVE.installation, GRILLE_FICTIVE.mensuel, GRILLE_FICTIVE.maintenance]);
    let precedente: unknown = null;
    for (const [version, engagement] of [[1, 24], [2, 36]] as const) {
      const p = (await c.query("INSERT INTO prereglages_metier (automatisation_id, metier_id, donnees, version, auteur, justification, version_precedente_id) VALUES ($1, $2, $3, $4, 'agent-essai', 'essai', $5) RETURNING id", [a, metier, JSON.stringify(donneesMetier(engagement)), version, precedente])).rows[0]?.["id"];
      await c.query("UPDATE prereglages_metier SET statut = 'publie' WHERE id = $1", [p]);
      precedente = p;
    }
    return { automatisation: a, metier };
  });
}
// Condition par défaut de la plateforme (frais, 777 centimes fictifs) valable le seul jour du 1er janvier 2031 ; l'auteur est obligatoire (colonne `auteur`).
// Aucun rôle ne peut supprimer la ligne : elle n'est écrite qu'une fois, et un second passage la retrouve (deux défauts sur la même clé seraient ambigus).
async function ecrireDefautPlateforme() {
  await ecrireEquipe(async (c) => {
    const existe = await c.query("SELECT 1 FROM conditions_par_defaut WHERE tenant_id = $1 AND type = 'frais' AND valide_du = '2031-01-01' AND valide_au = '2031-01-02'", [PLATEFORME_ID]);
    if (existe.rowCount) return;
    await c.query("INSERT INTO conditions_par_defaut (id, tenant_id, type, valeur, valide_du, valide_au, auteur) VALUES ($1, $2, 'frais', $3, '2031-01-01', '2031-01-02', 'agent-essai')", [randomUUID(), PLATEFORME_ID, JSON.stringify({ frais_mise_en_place_centimes: 777 })]);
  });
}
// Un client sans aucune condition, avec une instance à l'état pause rattachée à l'automatisation.
async function clientCatalogue(automatisationId: string, formule: string) {
  const A = randomUUID();
  await ins(A, "organisations", { id: A, console_client_id: A, raison_sociale: "Garage Fontaine" });
  const instance = (await ins(A, "instances", { organisation_id: A, code_automatisation: "relance-devis", formule, environnement: "test", etat: "pause", automatisation_id: automatisationId })) as string;
  const condition = (type: string, valeur: unknown, bornes: Record<string, string> = {}) => ins(A, "conditions_commerciales", { organisation_id: A, type, valeur: JSON.stringify(valeur), source: "client", auteur: "agent-essai", ...bornes });
  return { A, instance, condition };
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
    // Lecture par le rôle de l'application (la RLS est forcée, y compris pour le rôle de migration).
    const { rows } = await avecClient(app, a.A, (c) => c.query("SELECT frais_mise_en_place_ht_centimes AS f, prix_recurrent_mensuel_ht_centimes AS p, source_engagement AS s, auteur FROM plans_commerciaux WHERE tenant_id = $1 AND instance_id = $2", [a.A, instance]), APPELANT);
    expect(rows).toEqual([{ f: "100", p: "200", s: "client", auteur: "agent-essai" }]);
    await expect(avecClient(app, a.A, async (c) => enregistrerPlan(c, a.A, await preparerPlan(c, a.A, instance, {}), "agent-essai", "second"), APPELANT)).rejects.toMatchObject({ motif: "plan_existant" });
  });

  it("[C-138] @argent le plan passe par la grille, puis par les conditions du client, avec le préréglage de départ du métier", async () => {
    const cat = await catalogue(["abonnement", "achat"]);
    const a = await clientCatalogue(cat.automatisation, "abonnement");
    const preparer = (options: Record<string, unknown>) => avecClient(app, a.A, (c) => preparerPlan(c, a.A, a.instance, { date: "2026-03-10", ...options }), APPELANT);
    // Grille seule : frais et prix viennent de la grille ; engagement du métier (version de départ 1, alors que la 2 est publiée).
    const grille = await preparer({ metierId: cat.metier, versionMetier: 1 });
    expect(grille.sources.fraisMiseEnPlace).toBe("grille");
    expect([grille.fraisMiseEnPlaceHtCentimes, grille.prixRecurrentMensuelHtCentimes]).toEqual([GRILLE_FICTIVE.installation, GRILLE_FICTIVE.mensuel]);
    expect(grille.engagementMois).toBe(24);
    expect(grille.valeurs["engagement_mois"]).toMatchObject({ source: "metier", version: 1 });
    expect((await preparer({ metierId: cat.metier, versionMetier: 2 })).engagementMois).toBe(36);
    // Sans version de départ : refus, jamais la dernière publiée. Une version inexistante : refus aussi.
    await expect(preparer({ metierId: cat.metier })).rejects.toMatchObject({ motif: "version_metier_obligatoire" });
    await expect(preparer({ metierId: cat.metier, versionMetier: 9 })).rejects.toMatchObject({ motif: "prereglage_introuvable" });
    // Une condition du client l'emporte sur la grille.
    await a.condition("frais", { frais_mise_en_place_centimes: 100 });
    const client = await preparer({ metierId: cat.metier, versionMetier: 1 });
    expect(client.sources.fraisMiseEnPlace).toBe("client");
    expect(client.fraisMiseEnPlaceHtCentimes).toBe(100);
  });

  it("[C-138] @argent les conditions par défaut de la plateforme, lues par console_app, l'emportent sur la grille ; celles du client l'emportent sur elles", async () => {
    const cat = await catalogue(["abonnement"]);
    const a = await clientCatalogue(cat.automatisation, "abonnement");
    const preparer = (date: string) => avecClient(app, a.A, (c) => preparerPlan(c, a.A, a.instance, { metierId: cat.metier, versionMetier: 1, date }), APPELANT);
    // Une vraie ligne du niveau plateforme, écrite par l'équipe, bornée à une fenêtre que personne n'utilise (le jour du 1er janvier 2031).
    await ecrireDefautPlateforme();
    // Le défaut de la plateforme l'emporte sur la grille.
    const defaut = await preparer("2031-01-01");
    expect(defaut.sources.fraisMiseEnPlace).toBe("defaut");
    expect(defaut.fraisMiseEnPlaceHtCentimes).toBe(777);
    // valide_au est EXCLUE : le lendemain, seule la grille s'applique.
    expect((await preparer("2031-01-02")).sources.fraisMiseEnPlace).toBe("grille");
    // La condition du client l'emporte sur le défaut.
    await a.condition("frais", { frais_mise_en_place_centimes: 100 });
    const client = await preparer("2031-01-01");
    expect(client.sources.fraisMiseEnPlace).toBe("client");
    expect(client.fraisMiseEnPlaceHtCentimes).toBe(100);
  });

  it("[C-138] @argent une formule absente des formules actives de la grille est refusée", async () => {
    const cat = await catalogue(["abonnement"]);
    const a = await clientCatalogue(cat.automatisation, "achat");
    await expect(avecClient(app, a.A, (c) => preparerPlan(c, a.A, a.instance, { metierId: cat.metier, versionMetier: 1, date: "2026-03-10" }), APPELANT)).rejects.toMatchObject({ motif: "formule_non_proposee" });
  });

  it("[C-138] jour de passation : la condition qui finit le 10 mars cède à celle qui commence le 10 mars, sans valeur ambiguë", async () => {
    const cat = await catalogue(["abonnement"]);
    const a = await clientCatalogue(cat.automatisation, "abonnement");
    await a.condition("frais", { frais_mise_en_place_centimes: 100 }, { valide_au: "2026-03-10" });
    await a.condition("frais", { frais_mise_en_place_centimes: 300 }, { valide_du: "2026-03-10" });
    const jour = (date: string) => avecClient(app, a.A, (c) => preparerPlan(c, a.A, a.instance, { metierId: cat.metier, versionMetier: 1, date }), APPELANT);
    expect((await jour("2026-03-09")).fraisMiseEnPlaceHtCentimes).toBe(100);
    expect((await jour("2026-03-10")).fraisMiseEnPlaceHtCentimes).toBe(300);
    expect((await jour("2026-03-11")).fraisMiseEnPlaceHtCentimes).toBe(300);
  });
});

// T3-14a : lecture du plan enregistré et des conditions du client (essais pour la CI socle-integration ; non lancés sans démon Docker).
describe("lecture du plan d'un client (T3-14a)", () => {
  it("[A-040] une condition insérée pour le client est relue avec son auteur et la date de son journal", async () => {
    const { A } = await client(12);
    const lu = await avecClient(app, A, (c) => lirePlanClient(c, A, "2026-11-07"), APPELANT);
    const trois = lu.conditions.filter((c) => c.auteur === "agent-essai");
    expect(trois).toHaveLength(3);
    for (const c of trois) expect(Number.isNaN(Date.parse(String(c.modifieLe)))).toBe(false);
    expect(lu.instances).toHaveLength(1);
    expect(lu.instances[0]?.plan).toBeNull();
  });

  it("[LOT3-argent] @isolation lirePlanClient sous le client A ne rend ni plan ni condition du client B", async () => {
    const a = await client(12);
    const b = await client(24);
    const lu = await avecClient(app, a.A, (c) => lirePlanClient(c, a.A, "2026-11-07"), APPELANT);
    expect(lu.instances.map((i) => i.instanceId)).toEqual([a.instance]);
    expect(lu.instances.map((i) => i.instanceId)).not.toContain(b.instance);
    expect(lu.conditions.map((c) => (c.valeur as Record<string, unknown>)["engagement_mois"]).filter((v) => v !== undefined)).toEqual([12]);
    // Même avec l'identifiant de B demandé sous la portée de A, la RLS ne rend rien.
    const croise = await avecClient(app, a.A, (c) => lirePlanClient(c, b.A, "2026-11-07"), APPELANT);
    expect(croise.instances).toEqual([]);
    expect(croise.conditions).toEqual([]);
  });
});
