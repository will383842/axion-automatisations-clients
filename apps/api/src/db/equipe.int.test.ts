import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Migration 0020 (T3-05a, ADR 0115) : équipe, absences, vues, « Aujourd'hui », colonnes de demandes et de notes. Un essai par table.
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
const creerOrg = (id: string) => insererApp(id, "organisations", { id, console_client_id: id, raison_sociale: "Atelier Bertin" });
const ignorer = (A: string, extra: Record<string, unknown> = {}, appelant: typeof APPELANT | null = APPELANT) =>
  insererApp(A, "aujourdhui_ignores", { organisation_id: A, type_fait: "alerte.ouverte", reference: `alerte:${unique()}`, jour: "2026-11-06", motif: "deja_traite", membre: APPELANT.acteur, ...extra }, appelant);
const demande = (A: string, extra: Record<string, unknown> = {}) =>
  insererApp(A, "demandes", { organisation_id: A, canal: "courriel", categorie: "question", priorite: "normale", reference_texte: `demande:${randomUUID()}`, ...extra });
const note = (A: string) => insererApp(A, "notes", { organisation_id: A, auteur: APPELANT.acteur, texte: "Appel de suivi, rappeler jeudi.", type: "appel" });
const maj = (A: string, texte: string, valeurs: unknown[], appelant: typeof APPELANT | null = APPELANT) => ecrire(app, A, (c) => c.query(texte, valeurs), appelant ?? undefined);
// Membre de l'équipe (table commune) : le sujet est aussi l'acteur de ses requêtes (point F7 du plan).
const creerMembre = async (sujet = `membre-${unique()}`, role = "dirigeant") =>
  (await commeEquipe(APPELANT.acteur, (c) => c.query("INSERT INTO membres_equipe (sujet, role) VALUES ($1, $2) RETURNING id, sujet", [sujet, role]))).rows[0] as { id: string; sujet: string };
const ouvrirAbsence = (membre: string, acteur = APPELANT.acteur) =>
  commeEquipe(acteur, (c) => c.query("INSERT INTO absences (membre_id, debut, nature, ouverte_par) VALUES ($1, now(), 'annoncee', $2) RETURNING id", [membre, acteur]));
const creerVue = (membre: { id: string; sujet: string }, filtres: unknown = { statut: "ouvert" }, nom = `vue-${unique()}`) =>
  commeEquipe(membre.sujet, (c) => c.query("INSERT INTO vues_enregistrees (proprietaire_id, ecran, nom, filtres) VALUES ($1, 'clients', $2, $3::jsonb) RETURNING id", [membre.id, nom, JSON.stringify(filtres)]));

beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) {
    const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message?: string; detail?: string; constraint?: string; table?: string };
    writeSync(2, `ECHEC-MIGRATION 0020 : code=${c.code ?? "?"} message=${String(c.message ?? "").slice(0, 300)} detail=${String(c.detail ?? "").slice(0, 200)} contrainte=${c.constraint ?? ""} table=${c.table ?? ""}\n`);
    throw e;
  }
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("migration 0020 : équipe, vues, « Aujourd'hui », avec le socle", { timeout: 120_000 }, () => {
  it("[A-119] @isolation console_app du client A ne lit aucune ligne de B dans aujourdhui_ignores", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await ignorer(A);
    await ignorer(B);
    const sousA = await ecrire(app, A, (c) => c.query("SELECT tenant_id FROM aujourdhui_ignores"), APPELANT);
    expect(sousA.rows).toEqual([{ tenant_id: A }]);
    await expect(ignorer(A, { tenant_id: B, organisation_id: B })).rejects.toMatchObject({ code: "42501" });
    // Un jour, un fait : doublon refusé ; membre qui n'est pas l'acteur refusé ; rétablissement une seule fois.
    const fait = await ignorer(A, { reference: "alerte:doublon" });
    await expect(ignorer(A, { reference: "alerte:doublon" })).rejects.toMatchObject({ code: "23505" });
    await expect(ignorer(A, { membre: "autre-agent" })).rejects.toMatchObject({ code: "42501" });
    expect((await maj(A, "UPDATE aujourdhui_ignores SET retabli_le = now() WHERE id = $1", [fait["id"]])).rowCount).toBe(1);
    expect((await maj(A, "UPDATE aujourdhui_ignores SET retabli_le = now() WHERE id = $1", [fait["id"]])).rowCount).toBe(0);
    await expect(maj(A, "UPDATE aujourdhui_ignores SET reference = 'alerte:autre' WHERE id = $1", [fait["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "DELETE FROM aujourdhui_ignores WHERE id = $1", [fait["id"]])).rejects.toMatchObject({ code: "42501" });
  });

  it("[LOT3-tables] membres_equipe : console_app n'a ni lecture ni écriture", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(ecrire(app, A, (c) => c.query("SELECT * FROM membres_equipe"), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO membres_equipe (sujet, role) VALUES ($1, 'dirigeant')", [`membre-${unique()}`]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    // L'équipe écrit sous un acteur, jamais sans.
    await expect(commeEquipe(null, (c) => c.query("INSERT INTO membres_equipe (sujet, role) VALUES ($1, 'dirigeant')", [`membre-${unique()}`]))).rejects.toMatchObject({ code: "42501" });
    await expect(commeEquipe(APPELANT.acteur, (c) => c.query("INSERT INTO membres_equipe (sujet, role) VALUES ('sujet invalide!', 'dirigeant')"))).rejects.toMatchObject({ code: "23514" });
    await expect(commeEquipe(APPELANT.acteur, (c) => c.query("INSERT INTO membres_equipe (sujet, role) VALUES ($1, 'stagiaire')", [`membre-${unique()}`]))).rejects.toMatchObject({ code: "22P02" });
  });

  it("[LOT3-tables] absences : une seule absence ouverte par membre", async () => {
    const m = await creerMembre();
    await ouvrirAbsence(m.id);
    await expect(ouvrirAbsence(m.id)).rejects.toMatchObject({ code: "23505" });
  });

  it("[LOT3-tables] absences : une absence fermée ne se rouvre pas", async () => {
    const m = await creerMembre();
    const id = (await ouvrirAbsence(m.id)).rows[0]?.["id"] as string;
    const fermer = () => commeEquipe(APPELANT.acteur, (c) => c.query("UPDATE absences SET fin = now() + interval '1 hour', fermee_par = $2 WHERE id = $1", [id, APPELANT.acteur]));
    expect((await fermer()).rowCount).toBe(1);
    expect((await fermer()).rowCount).toBe(0);
    expect((await commeEquipe(APPELANT.acteur, (c) => c.query("UPDATE absences SET fin = NULL, fermee_par = NULL WHERE id = $1", [id]))).rowCount).toBe(0);
    await expect(commeEquipe(APPELANT.acteur, (c) => c.query("DELETE FROM absences WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("[LOT3-tables] vues_enregistrees : un membre ne lit pas la vue d'un autre membre", async () => {
    const m1 = await creerMembre(), m2 = await creerMembre();
    await creerVue(m1);
    const lire = (acteur: string) => commeEquipe(acteur, (c) => c.query("SELECT id FROM vues_enregistrees WHERE proprietaire_id = $1", [m1.id]));
    expect((await lire(m1.sujet)).rows).toHaveLength(1);
    expect((await lire(m2.sujet)).rows).toHaveLength(0);
    // Les filtres sont un objet JSON borné : un tableau est refusé, une vue au nom du voisin aussi.
    await expect(creerVue(m1, [])).rejects.toMatchObject({ code: "23514" });
    await expect(commeEquipe(m2.sujet, (c) => c.query("INSERT INTO vues_enregistrees (proprietaire_id, ecran, nom, filtres) VALUES ($1, 'clients', 'vol', '{}')", [m1.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, randomUUID(), (c) => c.query("SELECT * FROM vues_enregistrees"), APPELANT)).rejects.toMatchObject({ code: "42501" });
  });

  it("[LOT3-tables] un membre désactivé reste lisible dans l'historique", async () => {
    const m = await creerMembre();
    await ouvrirAbsence(m.id);
    await creerVue(m);
    await commeEquipe(APPELANT.acteur, (c) => c.query("UPDATE membres_equipe SET actif = false, desactive_le = now(), desactive_par = $2 WHERE id = $1", [m.id, APPELANT.acteur]));
    const histo = await commeEquipe(APPELANT.acteur, (c) => c.query("SELECT m.sujet, m.actif, a.id FROM membres_equipe m JOIN absences a ON a.membre_id = m.id WHERE m.id = $1", [m.id]));
    expect(histo.rows).toHaveLength(1);
    expect(histo.rows[0]).toMatchObject({ sujet: m.sujet, actif: false });
    // La vue (non partagée en V1) n'est plus servie à personne, mais elle est conservée en base.
    expect((await su.query("SELECT count(*)::int AS n FROM vues_enregistrees WHERE proprietaire_id = $1", [m.id])).rows[0]?.["n"]).toBe(1);
    await expect(commeEquipe(APPELANT.acteur, (c) => c.query("DELETE FROM membres_equipe WHERE id = $1", [m.id]))).rejects.toMatchObject({ code: "42501" });
    expect((await commeEquipe(APPELANT.acteur, (c) => c.query("UPDATE membres_equipe SET actif = true, desactive_le = NULL, desactive_par = NULL WHERE id = $1", [m.id]))).rowCount).toBe(0);
    // Une désactivation incomplète (sans date ou sans auteur) viole la contrainte de cohérence.
    const m2 = await creerMembre();
    await expect(commeEquipe(APPELANT.acteur, (c) => c.query("UPDATE membres_equipe SET actif = false WHERE id = $1", [m2.id]))).rejects.toMatchObject({ code: "23514" });
  });

  it("[LOT3-tables] demandes : satisfaction 0 ou 6 refusée, nulle permise", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const d = await demande(A);
    expect(d["qualification"]).toBe("aucune");
    expect(d["satisfaction"]).toBeNull();
    for (const mauvaise of [0, 6, -1]) {
      await expect(maj(A, "UPDATE demandes SET satisfaction = $2 WHERE id = $1", [d["id"], mauvaise]), String(mauvaise)).rejects.toMatchObject({ code: "23514" });
    }
    for (const bonne of [1, 5, null]) expect((await maj(A, "UPDATE demandes SET satisfaction = $2 WHERE id = $1", [d["id"], bonne])).rowCount).toBe(1);
    await expect(maj(A, "UPDATE demandes SET qualification = 'inconnue' WHERE id = $1", [d["id"]])).rejects.toMatchObject({ code: "22P02" });
    expect((await maj(A, "UPDATE demandes SET qualification = 'incident', echeance_prise_en_charge = now() WHERE id = $1", [d["id"]])).rowCount).toBe(1);
    // close_le n'existe qu'avec un statut résolu ou clos.
    await expect(maj(A, "UPDATE demandes SET close_le = now() WHERE id = $1", [d["id"]])).rejects.toMatchObject({ code: "23514" });
    // Le lien avec la référence reste inchangeable (colonne hors des droits).
    await expect(maj(A, "UPDATE demandes SET reference_texte = $2 WHERE id = $1", [d["id"], `demande:${randomUUID()}`])).rejects.toMatchObject({ code: "42501" });
  });

  it("[LOT3-tables] notes : console_app modifie epinglee et rien d'autre", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const n = await note(A);
    expect(n["epinglee"]).toBe(false);
    expect((await maj(A, "UPDATE notes SET epinglee = true WHERE id = $1", [n["id"]])).rowCount).toBe(1);
    await expect(maj(A, "UPDATE notes SET texte = 'autre' WHERE id = $1", [n["id"]])).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "UPDATE notes SET epinglee = false WHERE id = $1", [n["id"]], null)).rejects.toMatchObject({ code: "42501" });
    await expect(maj(A, "DELETE FROM notes WHERE id = $1", [n["id"]])).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-119] @isolation invariants C5 sans écart après 0020", async () => {
    const tables = (await migration.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => String(r.tablename));
    for (const t of ["membres_equipe", "absences", "vues_enregistrees", "aujourdhui_ignores"]) expect(tables).toContain(t);
    const ecarts = await controlerInvariants(requete, "console", OPTIONS);
    const publics = ecarts.filter((e) => tables.includes(e.objet.split(".")[0] ?? "") && !e.objet.startsWith("essai_"));
    expect(publics).toEqual([]);
  });
});

describe("T3-07b : accès en cours lus par console_equipe", { timeout: 120_000 }, () => {
  it("[B-026] la liste rend les interventions en cours de visibilite_acces et aucune intervention passée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const fin = new Date(Date.now() + 3_600_000).toISOString();
    const debut = new Date(Date.now() - 600_000).toISOString();
    await insererApp(A, "visibilite_acces", { organisation_id: A, intervention_perimetre: "lecture", intervention_debut: debut, intervention_fin: fin });
    // Une organisation par client (console_client_id = tenant_id) : l'intervention passée est portée par un second client.
    const B = randomUUID();
    await creerOrg(B);
    await insererApp(B, "visibilite_acces", { organisation_id: B, intervention_perimetre: "lecture", intervention_debut: new Date(Date.now() - 7_200_000).toISOString(), intervention_fin: new Date(Date.now() - 3_600_000).toISOString() });
    const { creerAccesInterventions } = await import("../equipe/acces-en-cours.ts");
    const vus = (await creerAccesInterventions(equipe).lister()).filter((a) => a.clientId === A || a.clientId === B);
    expect(vus).toEqual([{ type: "intervention", clientId: A, debut: new Date(debut).toISOString(), fin: new Date(fin).toISOString() }]);
  });
});
