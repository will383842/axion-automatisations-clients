import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

// Les écritures auditées passent par le verrou du journal : une attente trop longue (55P03) ou un interblocage (40P01) est rejoué.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      // 55P03 : attente du verrou du journal ; 40P01 : interblocage entre ce verrou et un verrou de ligne. PostgreSQL en tue un, l'appelant rejoue.
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 6) throw e;
    }
  }
}
// Depuis la 0007, console_app ne lit qu'une partie des colonnes d'instances : RETURNING * y serait refusé (42501).
const inserer = (tenant: string, table: string, valeurs: Record<string, unknown>, appelant: typeof APPELANT | null = APPELANT) => {
  const v = { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return ecrire(app, tenant, async (c) => (await c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${table === "instances" ? "tenant_id, id" : "*"}`, Object.values(v))).rows[0] as Record<string, unknown>, appelant ?? undefined);
};
const creerOrg = (id: string) => inserer(id, "organisations", { id, console_client_id: id, raison_sociale: "Lemoine Rénovation" });
// Pas de RETURNING * : console_app ne lit qu'une liste de colonnes de instances (migration 0007) ; seul l'identifiant revient.
const creerInstance = (A: string) =>
  ecrire(app, A, async (c) => (await c.query("INSERT INTO instances (id, tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $2, $2, 'relance-devis', 'abonnement', 'test', 'pause') RETURNING id", [randomUUID(), A])).rows[0] as Record<string, unknown>, APPELANT);
const SOURCES = Object.fromEntries(["formule", "frais_mise_en_place", "prix_recurrent_mensuel", "periode_facturation", "mode_avance", "maintenance_incluse", "suite_maintenance", "engagement"].map((v) => [`source_${v}`, "grille"]));
// Valeurs fictives (jamais un prix réel) : 100, 200 et 300 centimes.
const plan = (A: string, instance: unknown, extra: Record<string, unknown> = {}) =>
  inserer(A, "plans_commerciaux", { instance_id: instance, frais_mise_en_place_ht_centimes: 100, prix_recurrent_mensuel_ht_centimes: 200, periode_facturation_mois: 1, mode_avance: "aucune", maintenance_incluse_mois: 0, suite_maintenance: "arret", engagement_mois: 0, ...SOURCES, auteur: "agent-essai", ...extra });
const nouveauPlan = async (A: string) => plan(A, (await creerInstance(A))["id"]);
// Copie d'une facture du Hub (T2-05) : TVA toujours ajoutée (20 % sur 10 000 centimes), chaque mois sa facture.
const instanceDeFacture = new Map<string, Promise<unknown>>();
const factureDe = async (A: string, mois: number, extra: Record<string, unknown> = {}) => {
  // Une facture d'abonnement ou de complément se rattache à une instance (clé d'unicité) ; un avoir ou une mise en place n'en a pas besoin.
  const rattachee = ["abonnement", "complement_prorata"].includes((extra["nature"] as string | undefined) ?? "abonnement") && !("instance_id" in extra);
  if (rattachee && !instanceDeFacture.has(A)) instanceDeFacture.set(A, creerInstance(A).then((i) => i["id"]));
  const instance_id = rattachee ? await instanceDeFacture.get(A) : undefined;
  return inserer(A, "factures", { organisation_id: A, numero: `AXI-FACT-${randomUUID()}`, hub_id: randomUUID(), nature: "abonnement", plan: "essentiel", periode_debut: `2026-${String(mois).padStart(2, "0")}-01`, periode_fin: `2026-${String(mois).padStart(2, "0")}-${new Date(Date.UTC(2026, mois, 0)).getUTCDate()}`, montant_ht_centimes: 10000, taux_tva_points_de_base: 2000, montant_tva_centimes: 2000, montant_ttc_centimes: 12000, pdf_ref: "factures/a.pdf", empreinte_sha256: "a".repeat(64), auteur: APPELANT.acteur, ...(instance_id ? { instance_id } : {}), ...extra });
};
const echeance = (A: string, planId: unknown, extra: Record<string, unknown> = {}) =>
  inserer(A, "echeances", { plan_id: planId, debut_periode: "2026-01-01", fin_periode: "2026-02-01", montant_ht_centimes: 200, auteur: "agent-essai", ...extra });

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit par writeSync(2, …) (console.log y est avalé), lisible dans le journal du job.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("plan commercial, avec le socle", { timeout: 60_000 }, () => {
  it("[A-041] @argent un plan commercial lié à une instance : un seul plan par instance", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    const p = await plan(A, instance["id"]);
    // pg rend le bigint en chaîne ; le schéma Drizzle le lit en nombre (borné à 2^53 − 1).
    expect(p).toMatchObject({ prix_recurrent_mensuel_ht_centimes: "200", periode_facturation_mois: 1 });
    await expect(plan(A, instance["id"])).rejects.toMatchObject({ code: "23505" });
  });

  it("[A-126] @argent l'instance se lie à SON plan, jamais au plan d'une autre instance du même client", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const [i1, i2] = [await creerInstance(A), await creerInstance(A)];
    const [p1, p2] = [await plan(A, i1["id"]), await plan(A, i2["id"])];
    const lier = (instance: unknown, planId: unknown) => ecrire(app, A, (c) => c.query("UPDATE instances SET plan_commercial = $2 WHERE id = $1", [instance, planId]), APPELANT);
    await lier(i1["id"], p1["id"]);
    expect((await ecrire(app, A, (c) => c.query("SELECT plan_commercial FROM instances WHERE id = $1", [i1["id"]]))).rows[0]?.plan_commercial).toBe(p1["id"]);
    await expect(lier(i1["id"], p2["id"])).rejects.toMatchObject({ code: "23503" });
    await expect(lier(i2["id"], p1["id"])).rejects.toMatchObject({ code: "23503" });
    await expect(lier(i1["id"], randomUUID())).rejects.toMatchObject({ code: "23503" });
  });

  it("[A-143] @argent une valeur du plan sans sa source, ou avec une source inconnue, est refusée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    await expect(plan(A, instance["id"], { source_engagement: null })).rejects.toMatchObject({ code: "23502" });
    await expect(plan(A, instance["id"], { source_engagement: "devine" })).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-006] la formule n'a qu'une seule source dans la base : instances.formule, aucune autre table du plan ne la porte", async () => {
    const { rows } = await migration.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'formule' AND table_name = ANY($1) ORDER BY 1", [["instances", "organisations", "abonnements", "plans_commerciaux", "phases_plan", "echeances", "conditions_commerciales"]]);
    expect(rows.map((r) => r.table_name)).toEqual(["instances"]);
  });

  it("[A-125] un abonnement refuse une période hors 1, 6, 12 ; un plan aussi", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const abo = (extra: Record<string, unknown>) => inserer(A, "abonnements", { organisation_id: A, debut: "2026-01-01", quotas: JSON.stringify({ messages: 10 }), periode_facturation_mois: 12, mode_avance: "aucune", auteur: "agent-essai", ...extra });
    await expect(abo({})).resolves.toMatchObject({ periode_facturation_mois: 12 });
    await expect(abo({ periode_facturation_mois: 3 })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ mode_avance: "acompte", acompte_points_de_base: 2000.5 })).rejects.toMatchObject({ code: "22P02" });
    await expect(abo({ mode_avance: "acompte", acompte_points_de_base: 10001 })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ mode_avance: "acompte", acompte_points_de_base: 3000 })).resolves.toMatchObject({ acompte_points_de_base: 3000 });
    // [A-125] un acompte exige son taux, et un taux exige l'acompte.
    await expect(abo({ mode_avance: "acompte" })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ mode_avance: "aucune", acompte_points_de_base: 3000 })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ fin: "2025-12-31" })).rejects.toMatchObject({ code: "23514" });
    await expect(abo({ quotas: JSON.stringify([1]) })).rejects.toMatchObject({ code: "23514" });
    await expect(plan(A, (await creerInstance(A))["id"], { periode_facturation_mois: 3 })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-144] deux phases d'un plan avec le même ordre : la seconde est refusée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const phase = (extra: Record<string, unknown>) => inserer(A, "phases_plan", { plan_id: p["id"], ordre: 1, debut: "2026-01-01", nature: "recurrente", montant_ht_centimes: 200, periode_facturation_mois: 1, auteur: "agent-essai", ...extra });
    await phase({});
    await expect(phase({})).rejects.toMatchObject({ code: "23505" });
    await expect(phase({ ordre: 2 })).resolves.toMatchObject({ ordre: 2 });
    await expect(phase({ ordre: 3, montant_ht_centimes: -1 })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-145] @argent 10 insertions parallèles d'une échéance pour la même période : une seule ligne", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const resultats = await Promise.allSettled(Array.from({ length: 10 }, () => echeance(A, p["id"])));
    expect(resultats.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Table auditée : une attente du verrou du journal (55P03) reste possible pour un perdant ; la preuve est « une seule ligne ».
    const codes = resultats.flatMap((r) => (r.status === "rejected" ? [(r.reason as { code?: string }).code] : []));
    for (const c of codes) expect(["23505", "55P03", "40P01"]).toContain(c);
    // L'unicité doit avoir été exercée : au moins un perdant a reçu le refus d'unicité, pas seulement une attente de verrou.
    expect(codes).toContain("23505");
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
    await expect(plan(A, (await creerInstance(A))["id"], { prix_recurrent_mensuel_ht_centimes: -5 })).rejects.toMatchObject({ code: "23514" });
    const e = await echeance(A, p["id"], { debut_periode: "2026-05-01", fin_periode: "2026-06-01" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE echeances SET montant_ht_centimes = 1 WHERE id = $1", [e["id"]]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE echeances SET statut = 'payee' WHERE id = $1", [e["id"]]), APPELANT)).rejects.toMatchObject({ code: "23514" });
    await expect(ecrire(app, A, (c) => c.query("DELETE FROM echeances WHERE id = $1", [e["id"]]), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-145] @argent une échéance payée ne se rouvre pas, une annulée non plus, et emise ou payee exige sa date d'émission", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const maj = (id: unknown, set: string) => ecrire(app, A, (c) => c.query(`UPDATE echeances SET ${set} WHERE id = $1`, [id]), APPELANT);
    const statut = async (id: unknown) => (await ecrire(app, A, (c) => c.query("SELECT statut, date_paiement FROM echeances WHERE id = $1", [id]))).rows[0] as { statut: string; date_paiement: string | null };
    const e = await echeance(A, p["id"]);
    await expect(maj(e["id"], "statut = 'emise'")).rejects.toMatchObject({ code: "23514" });
    await maj(e["id"], "statut = 'emise', date_emission = '2026-01-02', auteur = 'agent-essai'");
    await expect(maj(e["id"], "statut = 'prevue', date_emission = NULL")).rejects.toMatchObject({ code: "42501" });
    await maj(e["id"], "statut = 'payee', date_paiement = '2026-01-10'");
    // Sorties de payee refusées : la ligne n'est plus modifiable (0 ligne), le paiement reste.
    for (const set of ["statut = 'prevue', date_paiement = NULL", "statut = 'annulee', date_paiement = NULL", "date_paiement = NULL", "statut = 'emise'"]) {
      // Aucun .catch : une erreur (autre qu'un refus silencieux de la politique) fait échouer l'essai au lieu de passer pour « 0 ligne ».
      expect((await maj(e["id"], set)).rowCount, set).toBe(0);
    }
    expect(await statut(e["id"])).toMatchObject({ statut: "payee" });
    expect((await statut(e["id"])).date_paiement).not.toBeNull();
    const f = await echeance(A, p["id"], { debut_periode: "2026-02-01", fin_periode: "2026-03-01" });
    await maj(f["id"], "statut = 'annulee'");
    expect((await maj(f["id"], "statut = 'emise', date_emission = '2026-02-02'")).rowCount).toBe(0);
    expect((await statut(f["id"])).statut).toBe("annulee");
    // Une échéance annulée ne se remplace pas pour la même période (unicité) : assumé jusqu'à T2-08 (ADR 0052).
    await expect(echeance(A, p["id"], { debut_periode: "2026-02-01", fin_periode: "2026-03-01" })).rejects.toMatchObject({ code: "23505" });
  });

  it("[A-145] @argent l'auteur écrit est l'appelant : une insertion ou une modification d'argent sans appelant, ou au nom d'un autre, est refusée (42501)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    const AUTRE = { acteur: "autre-agent", ip: "192.0.2.18" };
    await expect(plan(A, instance["id"], { auteur: "autre-agent" })).rejects.toMatchObject({ code: "42501" });
    const p = await plan(A, instance["id"]);
    await expect(echeance(A, p["id"], { auteur: "autre-agent" })).rejects.toMatchObject({ code: "42501" });
    const phase = { plan_id: p["id"], ordre: 1, debut: "2026-01-01", nature: "recurrente", montant_ht_centimes: 1, periode_facturation_mois: 1 };
    await expect(inserer(A, "phases_plan", { ...phase, auteur: "autre-agent" })).rejects.toMatchObject({ code: "42501" });
    await expect(inserer(A, "phases_plan", { ...phase, auteur: "agent-essai" }, null)).rejects.toMatchObject({ code: "42501" });
    const abo = { organisation_id: A, debut: "2026-01-01", periode_facturation_mois: 1, mode_avance: "aucune" };
    await expect(inserer(A, "abonnements", { ...abo, auteur: "autre-agent" })).rejects.toMatchObject({ code: "42501" });
    const a = await inserer(A, "abonnements", { ...abo, auteur: "agent-essai" });
    const f = await inserer(A, "phases_plan", { ...phase, auteur: "agent-essai" });
    // Modification au nom d'un autre appelant, ou sans appelant : refusée, même si elle ne touche pas la colonne auteur.
    await expect(ecrire(app, A, (c) => c.query("UPDATE abonnements SET fin = '2027-01-01' WHERE id = $1", [a["id"]]), AUTRE)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE phases_plan SET fin = '2027-01-01' WHERE id = $1", [f["id"]]))).rejects.toMatchObject({ code: "42501" });
    const e = await echeance(A, p["id"]);
    const emettre = "statut = 'emise', date_emission = '2026-01-02'";
    await expect(ecrire(app, A, (c) => c.query(`UPDATE echeances SET ${emettre} WHERE id = $1`, [e["id"]]))).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query(`UPDATE echeances SET ${emettre}, auteur = 'autre-agent' WHERE id = $1`, [e["id"]]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query(`UPDATE echeances SET ${emettre} WHERE id = $1`, [e["id"]]), AUTRE)).rejects.toMatchObject({ code: "42501" });
    expect((await ecrire(app, A, (c) => c.query(`UPDATE echeances SET ${emettre} WHERE id = $1`, [e["id"]]), APPELANT)).rowCount).toBe(1);
  });

  it("[A-145] @argent une échéance se crée toujours prevue et sans date de paiement : l'insertion payee ou annulee est refusée (42501)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    await expect(echeance(A, p["id"], { statut: "payee", date_emission: "2026-01-02", date_paiement: "2026-01-10" })).rejects.toMatchObject({ code: "42501" });
    await expect(echeance(A, p["id"], { statut: "annulee" })).rejects.toMatchObject({ code: "42501" });
    await expect(echeance(A, p["id"], { date_paiement: "2026-01-10" })).rejects.toMatchObject({ code: "42501" });
    await expect(echeance(A, p["id"])).resolves.toMatchObject({ statut: "prevue" });
  });

  it("[A-145] @argent une échéance se crée sans date d'émission ni facture (42501), et le paiement ne précède pas l'émission (23514)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    await expect(echeance(A, p["id"], { date_emission: "2026-01-02" })).rejects.toMatchObject({ code: "42501" });
    await expect(echeance(A, p["id"], { facture_id: (await factureDe(A, 1))["id"] })).rejects.toMatchObject({ code: "42501" }); // une facture réelle : la politique refuse, pas le déclencheur
    const e = await echeance(A, p["id"]);
    const maj = (set: string) => ecrire(app, A, (c) => c.query(`UPDATE echeances SET ${set} WHERE id = $1`, [e["id"]]), APPELANT);
    await expect(maj("statut = 'payee', date_emission = '2026-01-10', date_paiement = '2026-01-09'")).rejects.toMatchObject({ code: "23514" });
    expect((await maj("statut = 'payee', date_emission = '2026-01-10', date_paiement = '2026-01-10'")).rowCount).toBe(1);
  });

  it("[A-145] @argent une échéance émise ne se réécrit pas : emise vers emise, date_emission ou facture_id modifiés, paiement antidaté sont refusés (42501) ; payee et annulee sans toucher ces colonnes passent", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    // T2-05 : echeances.facture_id est une clé étrangère composée vers factures ; chaque échéance émise a sa propre facture (copie du Hub, fait de test).
    const factures: Record<number, string> = {};
    const mois = (n: number) => ({ debut_periode: `2026-0${n}-01`, fin_periode: `2026-0${n + 1}-01` });
    const emise = async (n: number) => {
      factures[n] = (await factureDe(A, n))["id"] as string;
      const e = await echeance(A, p["id"], mois(n));
      await ecrire(app, A, (c) => c.query("UPDATE echeances SET statut = 'emise', date_emission = '2026-01-02', facture_id = $2 WHERE id = $1", [e["id"], factures[n]]), APPELANT);
      return e["id"];
    };
    const maj = (id: unknown, set: string) => ecrire(app, A, (c) => c.query(`UPDATE echeances SET ${set} WHERE id = $1`, [id]), APPELANT);
    const e = await emise(1);
    await expect(maj(e, "statut = 'emise'")).rejects.toMatchObject({ code: "42501" });
    await expect(maj(e, "statut = 'emise', date_emission = '2026-01-03'")).rejects.toMatchObject({ code: "42501" });
    await expect(maj(e, "date_emission = '2026-01-03'")).rejects.toMatchObject({ code: "42501" });
    const autre = (await factureDe(A, 1, { plan: "avance" }))["id"]; // une autre facture réelle qui couvre la période : la politique refuse le changement de facture
    await expect(maj(e, `facture_id = '${autre}'`)).rejects.toMatchObject({ code: "42501" });
    await expect(maj(e, "statut = 'payee', date_emission = '2025-12-01', date_paiement = '2026-01-10'")).rejects.toMatchObject({ code: "42501" });
    await expect(maj(e, `statut = 'payee', facture_id = '${autre}', date_paiement = '2026-01-10'`)).rejects.toMatchObject({ code: "42501" });
    await expect(maj(e, "statut = 'annulee', date_emission = '2026-01-03'")).rejects.toMatchObject({ code: "42501" });
    const lue = async (id: unknown) => (await ecrire(app, A, (c) => c.query("SELECT statut, date_emission::text AS date_emission, facture_id FROM echeances WHERE id = $1", [id]))).rows[0] as { statut: string; date_emission: string; facture_id: string };
    expect(await lue(e)).toEqual({ statut: "emise", date_emission: "2026-01-02", facture_id: factures[1] });
    // Sans toucher date_emission ni facture_id : permis.
    expect((await maj(e, "statut = 'payee', date_paiement = '2026-01-10'")).rowCount).toBe(1);
    expect(await lue(e)).toEqual({ statut: "payee", date_emission: "2026-01-02", facture_id: factures[1] });
    const f = await emise(2);
    expect((await maj(f, "statut = 'annulee'")).rowCount).toBe(1);
    expect(await lue(f)).toMatchObject({ statut: "annulee", date_emission: "2026-01-02" });
    // Une échéance prevue passe toujours à emise avec sa date et sa facture.
    const g = await echeance(A, p["id"], mois(3));
    const f3 = (await factureDe(A, 3))["id"];
    expect((await maj(g["id"], `statut = 'emise', date_emission = '2026-03-02', facture_id = '${f3}'`)).rowCount).toBe(1);
  });

  it("[A-145] @argent une échéance ne se lie qu'à une facture qui couvre sa période, et une seule échéance par facture", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const lier = (e: unknown, facture: unknown) => ecrire(app, A, (c) => c.query("UPDATE echeances SET statut = 'emise', date_emission = '2026-01-02', facture_id = $2 WHERE id = $1", [e, facture]), APPELANT);
    const jan = await echeance(A, p["id"], { debut_periode: "2026-01-01", fin_periode: "2026-02-01" });
    const fev = await echeance(A, p["id"], { debut_periode: "2026-02-01", fin_periode: "2026-03-01" });
    const mars = await echeance(A, p["id"], { debut_periode: "2026-03-01", fin_periode: "2026-04-01" });
    // Période de l'échéance hors de celle de la facture : refusée par le déclencheur (la fin de l'échéance est exclue, celle de la facture incluse).
    const factureMars = await factureDe(A, 3);
    await expect(lier(jan["id"], factureMars["id"])).rejects.toMatchObject({ code: "P0001", message: "regle_metier", detail: "facture_incoherente" });
    const janvier = await factureDe(A, 1, { periode_fin: "2026-01-31" });
    await expect(lier(fev["id"], janvier["id"])).rejects.toMatchObject({ code: "P0001", detail: "facture_incoherente" });
    const debordante = await factureDe(A, 4, { periode_debut: "2026-02-15", periode_fin: "2026-03-31", plan: "avance" });
    await expect(lier(fev["id"], debordante["id"])).rejects.toMatchObject({ detail: "facture_incoherente" }); // la facture commence après l'échéance
    expect((await lier(jan["id"], janvier["id"])).rowCount).toBe(1); // fin exclue le 1er février, dernier jour inclus le 31 janvier
    // Une seule échéance par facture : la seconde, pourtant dans la période, est refusée.
    const trimestre = await factureDe(A, 2, { periode_debut: "2026-02-01", periode_fin: "2026-03-31", plan: "avance" });
    expect((await lier(fev["id"], trimestre["id"])).rowCount).toBe(1);
    await expect(lier(mars["id"], trimestre["id"])).rejects.toMatchObject({ code: "23505" });
    // Plusieurs échéances sans facture : permis.
    expect((await echeance(A, p["id"], { debut_periode: "2026-04-01", fin_periode: "2026-05-01" }))["statut"]).toBe("prevue");
  });

  it("[A-145] une facture inconnue ou d'un autre client est refusée par la clé étrangère composée (23503)", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const p = await nouveauPlan(A);
    const fb = await factureDe(B, 1);
    const e = await echeance(A, p["id"]);
    const lier = (facture: unknown) => ecrire(app, A, (c) => c.query("UPDATE echeances SET statut = 'emise', date_emission = '2026-01-02', facture_id = $2 WHERE id = $1", [e["id"], facture]), APPELANT);
    await expect(lier(fb["id"])).rejects.toMatchObject({ code: "P0001", message: "regle_metier", detail: "facture_incoherente" });
    await expect(lier(randomUUID())).rejects.toMatchObject({ code: "P0001", message: "regle_metier", detail: "facture_incoherente" });
  });

  it("[A-145] @argent une échéance ne se lie ni à un avoir ni à une facture annulée, mais à une facture d'abonnement ou de complément active (P0001 facture_incoherente)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const e = await echeance(A, p["id"]);
    const lier = (facture: unknown) => ecrire(app, A, (c) => c.query("UPDATE echeances SET statut = 'emise', date_emission = '2026-01-02', facture_id = $2 WHERE id = $1", [e["id"], facture]), APPELANT);
    const abonnement = await factureDe(A, 1);
    const avoirDe = await inserer(A, "factures", { organisation_id: A, numero: `AXI-AVOIR-${randomUUID()}`, hub_id: randomUUID(), nature: "avoir", facture_origine_id: abonnement["id"], plan: "essentiel", periode_debut: "2026-01-01", periode_fin: "2026-01-31", montant_ht_centimes: 10000, taux_tva_points_de_base: 2000, montant_tva_centimes: 2000, montant_ttc_centimes: 12000, pdf_ref: "factures/a.pdf", empreinte_sha256: "a".repeat(64), auteur: APPELANT.acteur });
    await expect(lier(avoirDe["id"])).rejects.toMatchObject({ code: "P0001", detail: "facture_incoherente" });
    await ecrire(app, A, (c) => c.query("UPDATE factures SET statut = 'annulee', statut_par = 'agent-essai' WHERE id = $1", [abonnement["id"]]), APPELANT);
    await expect(lier(abonnement["id"])).rejects.toMatchObject({ code: "P0001", detail: "facture_incoherente" }); // annulée
    const mise = await factureDe(A, 1, { nature: "mise_en_place", plan: null, code_automatisation: "relance-devis" });
    await expect(lier(mise["id"])).rejects.toMatchObject({ code: "P0001", detail: "facture_incoherente" }); // une mise en place ne porte pas une échéance d'abonnement
    const complement = await factureDe(A, 1, { nature: "complement_prorata", plan: null });
    expect((await lier(complement["id"])).rowCount).toBe(1);
  });

  it("[A-145] @argent une échéance annulée avec une facture exige sa date d'émission (23514)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const p = await nouveauPlan(A);
    const e = await echeance(A, p["id"]);
    const reelle = (await factureDe(A, 1))["id"];
    await expect(ecrire(app, A, (c) => c.query("UPDATE echeances SET statut = 'annulee', facture_id = $2 WHERE id = $1", [e["id"], reelle]), APPELANT)).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-146] @argent plans, abonnements, conditions : une colonne non accordée ne se modifie pas (42501), l'équipe n'écrit sur aucune table d'argent", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    const p = await plan(A, instance["id"]);
    const abo = await inserer(A, "abonnements", { organisation_id: A, debut: "2026-01-01", periode_facturation_mois: 1, mode_avance: "aucune", auteur: "agent-essai" });
    const cond = await inserer(A, "conditions_commerciales", { organisation_id: A, type: "remise", valeur: "{}", source: "client", auteur: "agent-essai" });
    const refus = (sql: string, params: unknown[]) => expect(ecrire(app, A, (c) => c.query(sql, params), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await refus("UPDATE plans_commerciaux SET prix_recurrent_mensuel_ht_centimes = 1 WHERE id = $1", [p["id"]]);
    await refus("UPDATE plans_commerciaux SET frais_mise_en_place_ht_centimes = 1 WHERE id = $1", [p["id"]]);
    await refus("UPDATE abonnements SET periode_facturation_mois = 12 WHERE id = $1", [abo["id"]]);
    await refus("UPDATE conditions_commerciales SET valeur = '{}'::jsonb WHERE id = $1", [cond["id"]]);
    const e = await echeance(A, p["id"]);
    for (const [table, id] of [["abonnements", abo["id"]], ["plans_commerciaux", p["id"]], ["phases_plan", randomUUID()], ["echeances", e["id"]]] as const) {
      await expect(equipe.query(`INSERT INTO ${table} DEFAULT VALUES`), `INSERT ${table}`).rejects.toMatchObject({ code: "42501" });
      await expect(equipe.query(`UPDATE ${table} SET auteur = 'x' WHERE id = $1`, [id]), `UPDATE ${table}`).rejects.toMatchObject({ code: "42501" });
      await expect(equipe.query(`DELETE FROM ${table} WHERE id = $1`, [id]), `DELETE ${table}`).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("[A-145] @argent un plan, une phase, une échéance ou un abonnement sans auteur, ou avec un auteur vide, est refusé (42501 : la politique « auteur = appelant » passe avant NOT NULL et CHECK)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    await expect(plan(A, instance["id"], { auteur: null })).rejects.toMatchObject({ code: "42501" });
    await expect(plan(A, instance["id"], { auteur: "  " })).rejects.toMatchObject({ code: "42501" });
    const p = await plan(A, instance["id"]);
    await expect(echeance(A, p["id"], { auteur: null })).rejects.toMatchObject({ code: "42501" });
    await expect(echeance(A, p["id"], { auteur: "" })).rejects.toMatchObject({ code: "42501" });
    await expect(inserer(A, "phases_plan", { plan_id: p["id"], ordre: 1, debut: "2026-01-01", nature: "recurrente", montant_ht_centimes: 1, periode_facturation_mois: 1, auteur: " " })).rejects.toMatchObject({ code: "42501" });
    await expect(inserer(A, "abonnements", { organisation_id: A, debut: "2026-01-01", periode_facturation_mois: 1, mode_avance: "aucune", auteur: " " })).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-146] une condition du client porte la source client, son auteur et ses dates", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const cond = (extra: Record<string, unknown>, appelant: typeof APPELANT | null = APPELANT) => inserer(A, "conditions_commerciales", { organisation_id: A, type: "remise", valeur: JSON.stringify({ points_de_base: 500 }), source: "client", auteur: "agent-essai", valide_du: "2026-01-01", ...extra }, appelant);
    await expect(cond({})).resolves.toMatchObject({ source: "client", auteur: "agent-essai" });
    await expect(cond({ source: "defaut" })).rejects.toMatchObject({ code: "23514" });
    // Auteur = appelant (politique restrictive) : un auteur vide, nul ou autre que l'appelant donne 42501, avant les contraintes de colonne.
    await expect(cond({ auteur: " " })).rejects.toMatchObject({ code: "42501" });
    await expect(cond({ auteur: null })).rejects.toMatchObject({ code: "42501" });
    await expect(cond({ auteur: "autre-agent" })).rejects.toMatchObject({ code: "42501" });
    await expect(cond({}, null)).rejects.toMatchObject({ code: "42501" });
    await expect(cond({ valide_au: "2025-12-31" })).rejects.toMatchObject({ code: "23514" });
    await expect(cond({ valeur: JSON.stringify([1]) })).rejects.toMatchObject({ code: "23514" });
    await expect(cond({ valeur: "5" })).rejects.toMatchObject({ code: "23514" });
  });

  it("[A-146] @argent une condition ne se modifie que par son appelant, et seules valide_au et auteur sont modifiables (valeur : 42501)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const c = await inserer(A, "conditions_commerciales", { organisation_id: A, type: "remise", valeur: JSON.stringify({ points_de_base: 500 }), source: "client", auteur: "agent-essai" });
    const maj = (set: string, appelant?: typeof APPELANT) => ecrire(app, A, (cl) => cl.query(`UPDATE conditions_commerciales SET ${set} WHERE id = $1`, [c["id"]]), appelant);
    await expect(maj("valide_au = '2030-01-01'")).rejects.toMatchObject({ code: "42501" });
    await expect(maj("valide_au = '2030-01-01'", { acteur: "autre-agent", ip: "192.0.2.18" })).rejects.toMatchObject({ code: "42501" });
    await expect(maj("valeur = '{}'::jsonb", APPELANT)).rejects.toMatchObject({ code: "42501" });
    expect((await maj("valide_au = '2030-01-01'", APPELANT)).rowCount).toBe(1);
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

  it("[A-163] @isolation un index unique sur echeances ou phases_plan sans tenant_id est signalé par unicite_sans_tenant (schéma d'essai) ; les index réels ne le sont pas", async () => {
    const schema = `essai_t204_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const copie = (nom: string, unique: string) => `
      CREATE TABLE ${schema}.${nom} (tenant_id uuid NOT NULL, id uuid NOT NULL, plan_id uuid NOT NULL, debut_periode date NOT NULL, ordre integer NOT NULL, PRIMARY KEY (tenant_id, id));
      CREATE INDEX ${nom}_tenant ON ${schema}.${nom} (tenant_id);
      ALTER TABLE ${schema}.${nom} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${schema}.${nom} FORCE ROW LEVEL SECURITY;
      CREATE POLICY isolation ON ${schema}.${nom} USING (tenant_id = current_setting('app.tenant_id')::uuid);
      ${unique};`;
    await migration.query(`CREATE SCHEMA ${schema}`);
    try {
      await migration.query(copie("echeances", `CREATE UNIQUE INDEX echeances_sans_tenant ON ${schema}.echeances (plan_id, debut_periode)`) + copie("phases_plan", `CREATE UNIQUE INDEX phases_sans_tenant ON ${schema}.phases_plan (plan_id, ordre)`));
      const tous = await controlerInvariants(requete, "console", OPTIONS);
      const signales = tous.filter((e) => e.regle === "unicite_sans_tenant" && e.objet.startsWith(`${schema}.`)).map((e) => e.objet).sort();
      expect(signales).toEqual([`${schema}.echeances.echeances_sans_tenant`, `${schema}.phases_plan.phases_sans_tenant`]);
      // Les index réels (tenant_id en tête) ne sont jamais signalés.
      expect(tous.filter((e) => e.regle === "unicite_sans_tenant" && e.objet.startsWith("public.") && /echeances|phases_plan|plans_commerciaux/.test(e.objet))).toEqual([]);
    } finally {
      await migration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it("[A-119] toutes les migrations appliquées, les invariants C5 ne trouvent aucun écart (dont montants en entiers)", async () => {
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
    const { rows } = await migration.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY 1", [["abonnements", "plans_commerciaux", "phases_plan", "echeances", "conditions_commerciales"]]);
    expect(rows).toHaveLength(5);
    expect(EXCEPTIONS_UNICITE).toEqual([]);
  });
});
