import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Migration 0021 (T3-05b, ADR 0115) : conformité, sous-traitants, signatures, historique des grilles. Un essai par table.
// Socle lancé par ops/socle/lancer.sh (job socle-integration). Les essais tournent en parallèle sur une base partagée : identifiants tirés au hasard.
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
const su = pool(DIRECT, "postgres", 2);
const app = pool(PGBOUNCER, "console_app", 30);
const equipe = pool(PGBOUNCER, "console_equipe", 5);
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const unique = () => randomUUID().replaceAll("-", "").slice(0, 8);
const JOUR = (decalage: number) => new Date(Date.UTC(2026, 10, 6 + decalage)).toISOString().slice(0, 10);

// Rejeu sur 55P03 (attente du verrou du journal) et 40P01 (interblocage), comme les autres essais d'intégration.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 6) throw e;
    }
  }
}
// Écriture de l'équipe sous un acteur (app.acteur), rejouée sur 55P03 / 40P01.
async function commeEquipe<T>(acteur: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let essai = 1; ; essai++) {
    const c = await equipe.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.acteur', $1, true), set_config('lock_timeout', '5s', true)", [acteur ?? ""]);
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
const insererApp = (tenant: string, table: string, valeurs: Record<string, unknown>, appelant: typeof APPELANT | null = APPELANT) => {
  const v = { id: randomUUID(), tenant_id: tenant, ...valeurs };
  const cles = Object.keys(v);
  return ecrire(app, tenant, async (c) => (await c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v))).rows[0] as Record<string, unknown>, appelant ?? undefined);
};
const creerOrg = (id: string) => insererApp(id, "organisations", { id, console_client_id: id, raison_sociale: "Boulangerie Rivoire" });
// Lignes des tables communes posées en superutilisateur (la RLS ne s'applique pas à lui) : traitement, automatisation.
const creerTraitement = async () =>
  (await su.query("INSERT INTO registre_traitements (code, finalite, base_legale, categories_donnees, destinataires, duree_conservation, mesures_securite) VALUES ($1, 'f', 'contrat', 'c', 'd', 'e', 'm') RETURNING id", [`essai-${unique()}`])).rows[0]?.["id"] as string;
const creerAutomatisation = async () => (await su.query("INSERT INTO automatisations (code, nom) VALUES ($1, 'Relance de devis') RETURNING id", [`ESS-${Math.floor(10_000 + Math.random() * 89_999)}`])).rows[0]?.["id"] as string;
async function commeSu<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', $1, true)", [APPELANT.acteur]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const registre = async (A: string, extra: Record<string, unknown> = {}) => insererApp(A, "registre_client", { organisation_id: A, traitement_id: await creerTraitement(), ...extra });
const droits = (A: string, extra: Record<string, unknown> = {}) =>
  insererApp(A, "demandes_droits", { organisation_id: A, reference: `droits:${randomUUID()}`, nature: "acces", recue_le: new Date().toISOString(), echeance_le: JOUR(40), ...extra });
const violation = (A: string, extra: Record<string, unknown> = {}) =>
  insererApp(A, "incidents_violations", { organisation_id: A, reference: `violation:${randomUUID()}`, niveau: "moyen", detecte_le: new Date().toISOString(), echeance_notification_le: new Date(Date.now() + 72 * 3_600_000).toISOString(), ...extra });
const aipd = async (A: string, extra: Record<string, unknown> = {}) => insererApp(A, "aipd", { organisation_id: A, automatisation_id: await creerAutomatisation(), echeance_le: JOUR(60), ...extra });
const maj = (A: string, texte: string, valeurs: unknown[], appelant: typeof APPELANT | null = APPELANT) => ecrire(app, A, (c) => c.query(texte, valeurs), appelant ?? undefined);
const sousTraitant = (acteur: string | null, annonce: string, effet: string) =>
  commeEquipe(acteur, (c) => c.query("INSERT INTO sous_traitants_ulterieurs (nom, service, pays, annonce_le, date_effet, ajoute_par) VALUES ($1, 'hebergement', 'FR', $2, $3, $4) RETURNING id", [`Fournisseur ${unique()}`, annonce, effet, acteur ?? "x"]));
const COMMUNES_LOT3 = ["membres_equipe", "absences", "vues_enregistrees", "sous_traitants_ulterieurs", "signatures_fiches", "historique_grilles_prix"];

beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) {
    const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message?: string; detail?: string; constraint?: string; table?: string };
    writeSync(2, `ECHEC-MIGRATION 0021 : code=${c.code ?? "?"} message=${String(c.message ?? "").slice(0, 300)} detail=${String(c.detail ?? "").slice(0, 200)} contrainte=${c.constraint ?? ""} table=${c.table ?? ""}\n`);
    throw e;
  }
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

// Lit sous A après avoir posé une ligne pour A et une pour B : une seule ligne visible, et une écriture au nom de B refusée (42501).
async function isole(table: string, poser: (t: string) => Promise<unknown>, auNomDeB: (A: string, B: string) => Promise<unknown>) {
  const A = randomUUID(), B = randomUUID();
  await creerOrg(A);
  await creerOrg(B);
  await poser(A);
  await poser(B);
  const sousA = await ecrire(app, A, (c) => c.query(`SELECT tenant_id FROM ${table}`), APPELANT);
  expect(sousA.rows).toEqual([{ tenant_id: A }]);
  await expect(auNomDeB(A, B)).rejects.toMatchObject({ code: "42501" });
}

describe("migration 0021 : conformité, avec le socle", { timeout: 120_000 }, () => {
  it("[A-119] @isolation console_app du client A ne lit aucune ligne de B dans registre_client", async () => {
    await isole("registre_client", registre, (A, B) => registre(A, { tenant_id: B, organisation_id: B }));
    const A = randomUUID();
    await creerOrg(A);
    const r = await registre(A);
    expect(r["refus_transfert_hors_ue"]).toBe(true);
    await expect(maj(A, "UPDATE registre_client SET fournisseur_ia_du_client = true WHERE id = $1", [r["id"]])).rejects.toMatchObject({ code: "23514" });
    await expect(maj(A, "UPDATE registre_client SET fournisseur_ia_code = 'Pas un code' WHERE id = $1", [r["id"]])).rejects.toMatchObject({ code: "23514" });
    await expect(maj(A, "UPDATE registre_client SET traitement_id = gen_random_uuid() WHERE id = $1", [r["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "DELETE FROM registre_client WHERE id = $1", [r["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(registre(A, { traitement_id: r["traitement_id"], organisation_id: A })).rejects.toMatchObject({ code: "23505" });
  });

  it("[A-119] @isolation console_app du client A ne lit aucune ligne de B dans demandes_droits", async () => {
    await isole("demandes_droits", droits, (A, B) => droits(A, { tenant_id: B, organisation_id: B }));
    const A = randomUUID();
    await creerOrg(A);
    await expect(droits(A, { statut: "repondue", repondue_le: new Date().toISOString() })).rejects.toMatchObject({ code: "42501" });
    await expect(droits(A, { reference: "droits:texte libre" })).rejects.toMatchObject({ code: "23514" });
    await expect(droits(A, { echeance_le: "2000-01-01" })).rejects.toMatchObject({ code: "23514" });
    const d = await droits(A);
    expect((await maj(A, "UPDATE demandes_droits SET statut = 'repondue', repondue_le = now(), reference_reponse = 'courrier:essai-1' WHERE id = $1", [d["id"]])).rowCount).toBe(1);
    // Répondue : plus de modification.
    expect((await maj(A, "UPDATE demandes_droits SET statut = 'refusee' WHERE id = $1", [d["id"]])).rowCount).toBe(0);
  });

  it("[A-119] @isolation console_app du client A ne lit aucune ligne de B dans incidents_violations", async () => {
    await isole("incidents_violations", violation, (A, B) => violation(A, { tenant_id: B, organisation_id: B }));
    const A = randomUUID();
    await creerOrg(A);
    await expect(violation(A, { statut: "close", close_le: new Date().toISOString() })).rejects.toMatchObject({ code: "42501" });
    await expect(violation(A, { echeance_notification_le: "2000-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "23514" });
    const v = await violation(A);
    expect((await maj(A, "UPDATE incidents_violations SET statut = 'close', close_le = now() WHERE id = $1", [v["id"]])).rowCount).toBe(1);
    expect((await maj(A, "UPDATE incidents_violations SET niveau = 'eleve' WHERE id = $1", [v["id"]])).rowCount).toBe(0);
  });

  it("[LOT3-tables] incidents_violations : l'échéance de notification ne se modifie pas", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const v = await violation(A);
    await expect(maj(A, "UPDATE incidents_violations SET echeance_notification_le = echeance_notification_le + interval '30 days' WHERE id = $1", [v["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "UPDATE incidents_violations SET detecte_le = now() WHERE id = $1", [v["id"]])).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-119] @isolation console_app du client A ne lit aucune ligne de B dans aipd", async () => {
    await isole("aipd", aipd, (A, B) => aipd(A, { tenant_id: B, organisation_id: B }));
    const A = randomUUID();
    await creerOrg(A);
    await expect(aipd(A, { statut: "validee", validee_le: new Date().toISOString() })).rejects.toMatchObject({ code: "42501" });
    await expect(aipd(A, { reference_document: "../secrets/x" })).rejects.toMatchObject({ code: "23514" });
    const a = await aipd(A);
    // Une seule AIPD non validée par (client, organisation, automatisation).
    await expect(insererApp(A, "aipd", { organisation_id: A, automatisation_id: a["automatisation_id"], echeance_le: JOUR(60) })).rejects.toMatchObject({ code: "23505" });
    expect((await maj(A, "UPDATE aipd SET statut = 'validee', validee_le = now(), reference_document = 'aipd/essai-1.pdf' WHERE id = $1", [a["id"]])).rowCount).toBe(1);
  });

  it("[LOT3-tables] les tables communes ajoutées sont écrites par console_equipe seul", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const t of COMMUNES_LOT3) {
      await expect(ecrire(app, A, (c) => c.query(`INSERT INTO ${t} DEFAULT VALUES`), APPELANT), `${t} INSERT`).rejects.toMatchObject({ code: "42501" });
      await expect(ecrire(app, A, (c) => c.query(`UPDATE ${t} SET id = id`), APPELANT), `${t} UPDATE`).rejects.toMatchObject({ code: "42501" });
      await expect(ecrire(app, A, (c) => c.query(`SELECT 1 FROM ${t}`), APPELANT), `${t} SELECT`).rejects.toMatchObject({ code: "42501" });
      await expect(commeEquipe(APPELANT.acteur, (c) => c.query(`DELETE FROM ${t}`)), `${t} DELETE`).rejects.toMatchObject({ code: "42501" });
      await expect(commeEquipe(APPELANT.acteur, (c) => c.query(`TRUNCATE ${t}`)), `${t} TRUNCATE`).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("[LOT3-tables] sous_traitants_ulterieurs : date d'effet à 29 jours de l'annonce refusée, à 30 jours acceptée", async () => {
    await expect(sousTraitant(APPELANT.acteur, JOUR(0), JOUR(29))).rejects.toMatchObject({ code: "23514" });
    expect((await sousTraitant(APPELANT.acteur, JOUR(0), JOUR(30))).rowCount).toBe(1);
    // L'auteur est l'acteur : sans acteur, refus.
    await expect(sousTraitant(null, JOUR(0), JOUR(30))).rejects.toMatchObject({ code: "42501" });
    await expect(commeEquipe(APPELANT.acteur, (c) => c.query("INSERT INTO sous_traitants_ulterieurs (nom, service, pays, annonce_le, date_effet, ajoute_par) VALUES ('Fournisseur X', 'service', 'France', $1, $2, $3)", [JOUR(0), JOUR(30), APPELANT.acteur]))).rejects.toMatchObject({ code: "23514" });
  });

  it("[LOT3-tables] historique_grilles_prix : une mise à jour est refusée, et un acteur vide refuse l'insertion", async () => {
    const auto = await creerAutomatisation();
    // Une grille porte de l'argent : le journal exige un acteur, même pour le superutilisateur qui pose la ligne d'essai.
    const grille = (await commeSu((c) => c.query("INSERT INTO grilles_prix (automatisation_id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur) VALUES ($1, '[]', 0, 0, 0, 0, 'essai') RETURNING id", [auto]))).rows[0]?.["id"] as string;
    const ajouter = (acteur: string | null, auteur: string, nouvelle = 1000) =>
      commeEquipe(acteur, (c) => c.query("INSERT INTO historique_grilles_prix (grille_id, champ, ancienne_valeur_centimes, nouvelle_valeur_centimes, auteur, raison) VALUES ($1, 'mensuel', 900, $2, $3, 'Mise à jour de la grille') RETURNING id", [grille, nouvelle, auteur]));
    await expect(ajouter(null, "x")).rejects.toMatchObject({ code: "42501" });
    await expect(ajouter(APPELANT.acteur, "autre-personne")).rejects.toMatchObject({ code: "42501" });
    await expect(ajouter(APPELANT.acteur, APPELANT.acteur, -1)).rejects.toMatchObject({ code: "23514" });
    const id = (await ajouter(APPELANT.acteur, APPELANT.acteur)).rows[0]?.["id"] as string;
    await expect(commeEquipe(APPELANT.acteur, (c) => c.query("UPDATE historique_grilles_prix SET nouvelle_valeur_centimes = 1 WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-119] @isolation invariants C5 sans écart après 0021", async () => {
    const tables = (await migration.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => String(r.tablename));
    for (const t of ["registre_client", "demandes_droits", "incidents_violations", "aipd", ...COMMUNES_LOT3]) expect(tables).toContain(t);
    const ecarts = await controlerInvariants(requete, "console", OPTIONS);
    const publics = ecarts.filter((e) => tables.includes(e.objet.split(".")[0] ?? "") && !e.objet.startsWith("essai_"));
    expect(publics).toEqual([]);
  });
});

// T3-31a1 (ADR 0135) : grille de prix, écrite par le vrai service et le vrai SQL, sous le rôle console_equipe. Aucun résultat n'est connu hors de la CI socle-integration.
// Chaque échec est journalisé (journal-echecs.ts, sans secret). Les essais de concurrence ouvrent leurs connexions directement, SANS commeEquipe (son rejeu masquerait la course).
type RequeteSql = (sql: string, valeurs: unknown[]) => Promise<Record<string, unknown>[]>;
const CORPS_GRILLE = { formules: ["abonnement"], frais_mise_en_place_ht_centimes: "12345", prix_mensuel_ht_centimes: "6789", maintenance_ensuite_ht_centimes: "1500", maintenance_incluse_mois: 3, motif: "Essai de grille" };
async function journaliserGrille<T>(nom: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    (await import("../provisionnement/journal-echecs.js")).ecrireEchec("conformite.int.test.ts", nom, e instanceof Error ? `${e.name} ${(e as { code?: string }).code ?? ""} ${e.message}` : "échec");
    throw e;
  }
}
// Transaction sur une connexion déjà prise (BEGIN déjà fait ou non), avec un point d'attente avant COMMIT.
function transactionSur(c: pg.PoolClient, o: { dejaOuverte?: boolean; avantCommit?: () => Promise<void> } = {}) {
  return async <T>(acteur: string, fn: (q: RequeteSql) => Promise<T>): Promise<T> => {
    try {
      if (!o.dejaOuverte) await c.query("BEGIN");
      await c.query("SELECT set_config('app.acteur', $1, true), set_config('lock_timeout', '5s', true)", [acteur]);
      const r = await fn(async (sql, v) => (await c.query(sql, v)).rows as Record<string, unknown>[]);
      if (o.avantCommit) await o.avantCommit();
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
}
const lectureEquipe = async <T>(fn: (q: RequeteSql) => Promise<T>): Promise<T> => {
  const c = await equipe.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const r = await fn(async (sql, v) => (await c.query(sql, v)).rows as Record<string, unknown>[]);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};
async function serviceGrilles(transaction?: <T>(acteur: string, fn: (q: RequeteSql) => Promise<T>) => Promise<T>) {
  const { creerServiceGrilles, depotSqlGrilles } = await import("../catalogue/grille.js");
  return creerServiceGrilles(depotSqlGrilles({ transaction: transaction ?? ((acteur, fn) => commeEquipe(acteur, (c) => fn(async (sql, v) => (await c.query(sql, v)).rows as Record<string, unknown>[]))), lecture: lectureEquipe }));
}
const grillesDe = async (auto: string) => (await su.query("SELECT * FROM grilles_prix WHERE automatisation_id = $1 ORDER BY cree_le, id", [auto])).rows as Record<string, unknown>[];
const historiqueDe = async (auto: string) => (await su.query("SELECT h.* FROM historique_grilles_prix h JOIN grilles_prix g ON g.id = h.grille_id WHERE g.automatisation_id = $1", [auto])).rows as Record<string, unknown>[];
const empreinte = async (table: string) => String((await su.query(`SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS e FROM ${table} t`)).rows[0]?.["e"]);

describe("T3-31a1 grille de prix en vraie base", () => {
  it("[LOT3-prix] @argent changer un prix crée l'historique exact et ne touche aucun plan ni échéance existants", () => journaliserGrille("historique exact", async () => {
    const auto = await creerAutomatisation();
    const service = await serviceGrilles();
    const avant = [await empreinte("plans_commerciaux"), await empreinte("echeances"), await empreinte("conditions_commerciales")];
    const g1 = await service.ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, grille_precedente_id: null });
    const g2 = await service.ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, prix_mensuel_ht_centimes: "7000", grille_precedente_id: g1.grille.id });
    expect([await empreinte("plans_commerciaux"), await empreinte("echeances"), await empreinte("conditions_commerciales")]).toEqual(avant);
    // Contre-calcul : relire les deux grilles en base et recalculer l'historique de la seconde.
    const lignes = await grillesDe(auto);
    expect(lignes).toHaveLength(2);
    const [r1, r2] = lignes as [Record<string, unknown>, Record<string, unknown>];
    expect(r2["id"]).toBe(g2.grille.id);
    const colonne = { installation: "montant_installation_centimes", mensuel: "montant_mensuel_centimes", maintenance_ensuite: "maintenance_ensuite_centimes", maintenance_incluse_mois: "maintenance_incluse_mois" } as const;
    const attendues = Object.entries(colonne).filter(([, col]) => String(r1[col]) !== String(r2[col])).map(([champ]) => champ);
    expect(attendues).toEqual(["mensuel"]);
    const h2 = (await historiqueDe(auto)).filter((h) => h["grille_id"] === g2.grille.id);
    expect(h2.map((h) => h["champ"])).toEqual(attendues);
    expect(h2[0]).toMatchObject({ grille_precedente_id: r1["id"], ancienne_valeur_centimes: "6789", nouvelle_valeur_centimes: "7000", auteur: APPELANT.acteur });
    // Première grille : quatre lignes sans ancienne valeur.
    expect((await historiqueDe(auto)).filter((h) => h["grille_id"] === g1.grille.id && h["ancienne_valeur_centimes"] === null)).toHaveLength(4);
  }));

  it("[LOT3-prix] @argent deux changements simultanés : un seul passe et l'historique reste complet", () => journaliserGrille("deux changements", async () => {
    const auto = await creerAutomatisation();
    const g0 = await (await serviceGrilles()).ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, grille_precedente_id: null });
    // A pose le verrou et attend ; B arrive pendant ce temps et attend à son tour ; A valide ; B voit la grille changée et est refusé.
    let liberer!: () => void;
    const feu = new Promise<void>((r) => { liberer = r; });
    let aPret!: () => void;
    const pret = new Promise<void>((r) => { aPret = r; });
    const cA = await equipe.connect();
    const cB = await equipe.connect();
    const sA = await serviceGrilles(transactionSur(cA, { avantCommit: async () => { aPret(); await feu; } }));
    const sB = await serviceGrilles(transactionSur(cB));
    const pA = sA.ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, prix_mensuel_ht_centimes: "7000", grille_precedente_id: g0.grille.id });
    await pret;
    const pB = sB.ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, prix_mensuel_ht_centimes: "8000", grille_precedente_id: g0.grille.id });
    const issueB = pB.then(() => "passe", (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    liberer();
    expect((await pA).grille.prix_mensuel_ht_centimes).toBe("7000");
    expect(await issueB).toMatchObject({ code: "regle_metier", message: "La grille a changé entre-temps : rechargez-la." });
    const grilles = await grillesDe(auto);
    expect(grilles).toHaveLength(2);
    const historique = await historiqueDe(auto);
    const ids = new Set(grilles.map((g) => g["id"]));
    expect(historique.every((h) => ids.has(h["grille_id"]))).toBe(true);
    expect(historique.filter((h) => h["grille_id"] !== g0.grille.id).map((h) => [h["champ"], h["nouvelle_valeur_centimes"]])).toEqual([["mensuel", "7000"]]);
  }));

  it("[LOT3-prix] une transaction ouverte avant la dernière grille ne peut pas en écrire une plus ancienne", () => journaliserGrille("transaction plus ancienne", async () => {
    const auto = await creerAutomatisation();
    const g0 = await (await serviceGrilles()).ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, grille_precedente_id: null });
    const cB = await equipe.connect();
    await cB.query("BEGIN");
    await cB.query("SELECT 1");
    // A écrit et valide APRÈS l'ouverture de la transaction de B : sa grille porte un cree_le postérieur au now() de B.
    const gA = await (await serviceGrilles()).ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, prix_mensuel_ht_centimes: "7000", grille_precedente_id: g0.grille.id });
    const sB = await serviceGrilles(transactionSur(cB, { dejaOuverte: true }));
    await expect(sB.ecrire(auto, APPELANT.acteur, { ...CORPS_GRILLE, prix_mensuel_ht_centimes: "8000", grille_precedente_id: gA.grille.id })).rejects.toMatchObject({ code: "regle_metier", message: "La grille a changé entre-temps : rechargez-la." });
    expect(await grillesDe(auto)).toHaveLength(2);
  }));

  it("[LOT3-prix] console_equipe pose le verrou FOR NO KEY UPDATE sur automatisations", () => journaliserGrille("verrou", async () => {
    const auto = await creerAutomatisation();
    const r = await commeEquipe(APPELANT.acteur, (c) => c.query("SELECT statut FROM automatisations WHERE id = $1 FOR NO KEY UPDATE", [auto]));
    expect(r.rows).toHaveLength(1);
  }));
});
