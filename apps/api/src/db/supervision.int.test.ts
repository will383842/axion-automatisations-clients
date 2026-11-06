import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Migrations 0022 (T5-01a) et 0023 (T5-01b), ADR 0116 : tables de la supervision par client, tables communes et rôle de lecture console_lecture (A-188).
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
const app = pool(PGBOUNCER, "console_app", 20);
const equipe = pool(PGBOUNCER, "console_equipe", 5);
const lecture = pool(PGBOUNCER, "console_lecture", 5);
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe|lecture)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

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
const creerOrg = (id: string) =>
  ecrire(app, id, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Boulangerie Rivoire')", [id]), APPELANT);
const creerInstance = async (A: string) =>
  (await ecrire(app, A, (c) => c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'relance-devis', 'abonnement', 'test', 'pause') RETURNING id", [A]), APPELANT)).rows[0]?.["id"] as string;
const poserSante = (A: string, instance: string) =>
  ecrire(app, A, (c) => c.query("INSERT INTO sante_instances (tenant_id, id, instance_id, etat) VALUES ($1, $2, $3, 'saine')", [A, randomUUID(), instance]), APPELANT);
const poserMesure = (A: string, extra = "cli_essai") =>
  commeEquipe("agent-essai", (c) =>
    c.query("INSERT INTO mesures_bases (tenant_id, id, debut, base, taille_octets, connexions, requetes_lentes, lignes_mortes, version_structure) VALUES ($1, $2, now(), $3, 1000, 2, 0, 0, '0022')", [A, randomUUID(), extra]),
  );
const lireSous = (p: pg.Pool, A: string, texte: string) => ecrire(p, A, (c) => c.query(texte));

beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) {
    const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message?: string; detail?: string; constraint?: string; table?: string };
    writeSync(2, `ECHEC-MIGRATION 0022 : code=${c.code ?? "?"} message=${String(c.message ?? "").slice(0, 300)} detail=${String(c.detail ?? "").slice(0, 200)} contrainte=${c.constraint ?? ""} table=${c.table ?? ""}\n`);
    throw e;
  }
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("migration 0022 : supervision par client, avec le socle", { timeout: 120_000 }, () => {
  it("[A-188] console_lecture lit sante_instances et ne peut rien écrire", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = await creerInstance(A);
    await poserSante(A, instance);
    expect((await lireSous(lecture, A, "SELECT etat FROM sante_instances")).rows).toEqual([{ etat: "saine" }]);
    for (const sql of [
      `INSERT INTO sante_instances (tenant_id, id, instance_id) VALUES ('${A}', '${randomUUID()}', '${instance}')`,
      "UPDATE sante_instances SET etat = 'en_panne'",
      "DELETE FROM sante_instances",
      "TRUNCATE sante_instances",
    ]) {
      await expect(lireSous(lecture, A, sql), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("[A-188] @isolation console_lecture avec le client A ne lit aucune ligne de B", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await poserSante(A, await creerInstance(A));
    await poserSante(B, await creerInstance(B));
    await poserMesure(A);
    await poserMesure(B);
    for (const table of ["sante_instances", "mesures_bases", "alertes", "agregats_quotidiens", "liens_retour", "rapports_mensuels", "suspensions_abus"]) {
      const sousA = await lireSous(lecture, A, `SELECT DISTINCT tenant_id FROM ${table}`);
      expect(sousA.rows.every((r) => r["tenant_id"] === A), table).toBe(true);
    }
    expect((await lireSous(lecture, A, "SELECT count(*)::int AS n FROM sante_instances")).rows[0]?.["n"]).toBe(1);
    expect((await lireSous(lecture, A, "SELECT count(*)::int AS n FROM mesures_bases")).rows[0]?.["n"]).toBe(1);
    // Sans client actif, aucune ligne.
    expect((await lecture.query("SELECT count(*)::int AS n FROM sante_instances")).rows[0]?.["n"]).toBe(0);
  });

  it("[LOT5-tables] mesures_bases : console_app n'a aucun droit, base de forme cli_<id> seulement", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(ecrire(app, A, (c) => c.query("SELECT 1 FROM mesures_bases"), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(poserMesure(A, "Boulangerie Rivoire")).rejects.toMatchObject({ code: "23514" });
    await poserMesure(A);
  });

  it("[LOT5-tables] suspensions_abus : console_app ne peut ni insérer ni lever une suspension, console_equipe l'insère sous un client présent", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = randomUUID();
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO suspensions_abus (tenant_id, id, organisation_id, etape, motif, posee_par) VALUES ($1, $2, $1, 'avertissement', 'plaintes', 'agent-essai')", [A, id]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await commeEquipe("agent-essai", (c) => c.query("INSERT INTO suspensions_abus (tenant_id, id, organisation_id, etape, motif, posee_par) VALUES ($1, $2, $1, 'avertissement', 'plaintes', 'agent-essai')", [A, id]));
    await expect(ecrire(app, A, (c) => c.query("UPDATE suspensions_abus SET levee_par = 'x', levee_le = now() WHERE id = $1", [id]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(commeEquipe(null, (c) => c.query("INSERT INTO suspensions_abus (tenant_id, id, organisation_id, etape, motif, posee_par) VALUES ($1, $2, $1, 'limitation', 'autre', 'x')", [A, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    expect((await commeEquipe("agent-essai", (c) => c.query("UPDATE suspensions_abus SET levee_par = 'agent-essai', levee_le = now() WHERE id = $1", [id]))).rowCount).toBe(1);
  });

  it("[LOT5-tables] une partition future de mesures_bases a RLS et FORCE", async () => {
    const c = await migration.connect();
    try {
      await c.query("BEGIN");
      const avant = new Set((await c.query("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'public.mesures_bases'::regclass")).rows.map((r) => r.relname as string));
      let cree = false;
      for (let essai = 0; essai < 20 && !cree; essai++) {
        const lointain = 15 + Math.floor(Math.random() * 300);
        cree = (await c.query("SELECT partman.create_partition_time('public.mesures_bases', ARRAY[date_trunc('month', now()) + make_interval(months => $1)]) AS cree", [lointain])).rows[0]?.cree === true;
      }
      expect(cree).toBe(true);
      const nom = (await c.query("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'public.mesures_bases'::regclass")).rows.map((r) => r.relname as string).find((n) => !avant.has(n)) as string;
      const etat = async () => (await c.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force, (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS politiques, has_table_privilege('console_lecture', c.oid, 'SELECT') AS lecture_lit, has_table_privilege('console_app', c.oid, 'SELECT') AS app_lit, has_table_privilege('console_equipe', c.oid, 'SELECT') AS equipe_lit FROM pg_class c WHERE c.relname = $1", [nom])).rows[0];
      expect(await etat()).toMatchObject({ rls: false, lecture_lit: false, app_lit: false, equipe_lit: false });
      await c.query("SELECT public.mesures_bases_proteger_partitions()");
      expect(await etat()).toMatchObject({ rls: true, force: true, politiques: 3, lecture_lit: false, app_lit: false, equipe_lit: false });
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    const { rows } = await migration.query("SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'public.mesures_bases'::regclass AND NOT (c.relrowsecurity AND c.relforcerowsecurity)");
    expect(rows[0]?.n).toBe(0);
    for (const role of ["console_app", "console_equipe", "console_lecture"]) {
      expect((await migration.query("SELECT has_function_privilege($1, 'public.mesures_bases_proteger_partitions()', 'EXECUTE') AS ok", [role])).rows[0]?.ok, role).toBe(false);
    }
  });

  it("[LOT5-tables] invariants C5 sans écart après la migration", async () => {
    const ecarts = await controlerInvariants(requete, "console", OPTIONS);
    expect(ecarts.filter((e) => /^(sante_instances|liens_retour|suspensions_abus|rapports_mensuels|mesures_bases)/.test(e.objet))).toEqual([]);
    expect(ecarts.filter((e) => e.regle === "role_contourne_rls")).toEqual([]);
  });
});

// Migration 0023 (T5-01b) : tables communes de la supervision, incidents_instances et commentaires_alertes par client, colonnes d'alertes (mesures_capacite non partitionnée : ESCALADE C5).
const poserIncident = (cause = "panne_essai") =>
  commeEquipe("agent-essai", async (c) => (await c.query("INSERT INTO incidents (cause, gravite, debut, detecte_le) VALUES ($1, 'mineure', now() - interval '1 hour', now()) RETURNING id", [cause])).rows[0]?.["id"] as string);
const lierIncident = (A: string, incident: string, instance: string) =>
  commeEquipe("agent-essai", (c) => c.query("INSERT INTO incidents_instances (tenant_id, id, incident_id, instance_id) VALUES ($1, $2, $3, $4)", [A, randomUUID(), incident, instance]));
const poserAlerte = async (A: string) => {
  const id = randomUUID();
  await ecrire(app, A, (c) => c.query("INSERT INTO alertes (tenant_id, id, organisation_id, type, gravite, regle) VALUES ($1, $2, $1, 'essai', 'information', 'essai')", [A, id]), APPELANT);
  return id;
};

describe("migration 0023 : supervision commune, avec le socle", { timeout: 120_000 }, () => {
  it("[LOT5-tables] @isolation incidents_instances du client B invisible depuis A, y compris par jointure depuis incidents", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const incident = await poserIncident();
    await lierIncident(A, incident, await creerInstance(A));
    await lierIncident(B, incident, await creerInstance(B));
    // La table commune `incidents` ne dit pas QUELS clients : seule incidents_instances, sous RLS, le dit.
    for (const [role, pool_] of [["console_app", app], ["console_lecture", lecture]] as const) {
      const direct = await lireSous(pool_, A, "SELECT tenant_id FROM incidents_instances");
      expect(direct.rows, role).toEqual([{ tenant_id: A }]);
      const jointure = await lireSous(pool_, A, `SELECT ii.tenant_id FROM incidents i JOIN incidents_instances ii ON ii.incident_id = i.id WHERE i.id = '${incident}'`);
      expect(jointure.rows, role).toEqual([{ tenant_id: A }]);
      const inverse = await lireSous(pool_, A, `SELECT count(*)::int AS n FROM incidents_instances WHERE tenant_id = '${B}'`);
      expect(inverse.rows[0]?.["n"], role).toBe(0);
    }
    // Sans client actif, aucune ligne ; l'instance d'un autre client est refusée comme une instance inexistante (clé étrangère composite).
    expect((await app.query("SELECT count(*)::int AS n FROM incidents_instances").catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.["n"]).toBe(0);
    await expect(lierIncident(A, incident, await creerInstance(B))).rejects.toMatchObject({ code: "23503" });
    // console_app ne peut ni écrire ni supprimer dans incidents_instances.
    for (const sql of [`INSERT INTO incidents_instances (tenant_id, id, incident_id, instance_id) VALUES ('${A}', '${randomUUID()}', '${incident}', '${randomUUID()}')`, "DELETE FROM incidents_instances", "UPDATE incidents_instances SET cree_le = now()"]) {
      await expect(lireSous(app, A, sql), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("[LOT5-tables] console_app ne peut pas écrire dans disjoncteurs ni modeles_messages", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(lireSous(app, A, "INSERT INTO disjoncteurs (portee, motif_code, pose_par) VALUES ('envois_plateforme', 'essai', 'x')"), "disjoncteurs").rejects.toMatchObject({ code: "42501" });
    await expect(lireSous(app, A, "INSERT INTO modeles_messages (cle, version, texte, cree_par) VALUES ('essai', 1, 'Bonjour', 'x')"), "modeles_messages").rejects.toMatchObject({ code: "42501" });
    await expect(lireSous(app, A, "UPDATE modeles_messages SET texte = 'x'")).rejects.toMatchObject({ code: "42501" });
    // L'équipe écrit, avec son nom comme auteur ; sans acteur, ou avec un autre nom, l'écriture est refusée.
    const cle = `essai_${randomUUID().slice(0, 8)}`;
    await commeEquipe("agent-essai", (c) => c.query("INSERT INTO modeles_messages (cle, version, texte, cree_par) VALUES ($1, 1, 'Bonjour {prenom}', 'agent-essai')", [cle]));
    await expect(commeEquipe("agent-essai", (c) => c.query("INSERT INTO modeles_messages (cle, version, texte, cree_par) VALUES ($1, 2, 'x', 'autre-personne')", [cle]))).rejects.toMatchObject({ code: "42501" });
    await expect(commeEquipe(null, (c) => c.query("INSERT INTO modeles_messages (cle, version, texte, cree_par) VALUES ($1, 3, 'x', 'x')", [cle]))).rejects.toMatchObject({ code: "42501" });
    await expect(commeEquipe("agent-essai", (c) => c.query("UPDATE modeles_messages SET texte = 'x' WHERE cle = $1", [cle]))).rejects.toMatchObject({ code: "42501" });
    expect((await lireSous(app, A, `SELECT texte FROM modeles_messages WHERE cle = '${cle}'`)).rows).toEqual([{ texte: "Bonjour {prenom}" }]);
  });

  it("[LOT5-tables] console_app ne lit ni disjoncteurs ni reveils", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const sql of ["SELECT 1 FROM disjoncteurs", "SELECT 1 FROM reveils", "INSERT INTO reveils (heure, cause, duree_s, justification, auteur) VALUES (now(), 'essai', 60, 'essai', 'x')"]) {
      await expect(lireSous(app, A, sql), sql).rejects.toMatchObject({ code: "42501" });
      await expect(lireSous(lecture, A, sql), `lecture ${sql}`).rejects.toMatchObject({ code: "42501" });
    }
    // L'équipe pose un disjoncteur, une seule fois par cible tant qu'il n'est pas levé ; la plateforme n'a pas de cible.
    const cible = randomUUID();
    await commeEquipe("agent-essai", (c) => c.query("INSERT INTO disjoncteurs (portee, cible, motif_code, pose_par) VALUES ('envois_instance', $1, 'essai', 'agent-essai')", [cible]));
    await expect(commeEquipe("agent-essai", (c) => c.query("INSERT INTO disjoncteurs (portee, cible, motif_code, pose_par) VALUES ('envois_instance', $1, 'essai', 'agent-essai')", [cible]))).rejects.toMatchObject({ code: "23505" });
    await expect(commeEquipe("agent-essai", (c) => c.query("INSERT INTO disjoncteurs (portee, cible, motif_code, pose_par) VALUES ('envois_plateforme', $1, 'essai', 'agent-essai')", [cible]))).rejects.toMatchObject({ code: "23514" });
    await expect(commeEquipe("agent-essai", (c) => c.query("INSERT INTO disjoncteurs (portee, motif_code, pose_par) VALUES ('cellule', 'essai', 'agent-essai')"))).rejects.toMatchObject({ code: "23514" });
    expect((await commeEquipe("agent-essai", (c) => c.query("UPDATE disjoncteurs SET leve_par = 'agent-essai', leve_le = now() WHERE cible = $1", [cible]))).rowCount).toBe(1);
  });

  it("[LOT5-tables] incidents.cause refuse un texte libre", async () => {
    for (const cause of ["Boulangerie Rivoire", "contact@exemple.fr", "a".repeat(65), "Panne"]) {
      await expect(poserIncident(cause), cause).rejects.toMatchObject({ code: "23514" });
    }
    await expect(commeEquipe("agent-essai", (c) => c.query("INSERT INTO incidents (cause, gravite, debut, detecte_le) VALUES ('essai', 'mineure', now(), now() - interval '1 hour')"))).rejects.toMatchObject({ code: "23514" });
    await poserIncident("cause_code.v1");
  });

  it("[LOT5-tables] commentaires_alertes : ajout seul, auteur = acteur, texte limité à 500 caractères, jamais lisible chez un autre client", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const alerteA = await poserAlerte(A);
    const alerteB = await poserAlerte(B);
    const inserer = (client: string, alerte: string, auteur: string, texte: string) =>
      ecrire(app, client, (c) => c.query("INSERT INTO commentaires_alertes (tenant_id, id, alerte_id, auteur, texte) VALUES ($1, $2, $3, $4, $5)", [client, randomUUID(), alerte, auteur, texte]), APPELANT);
    await inserer(A, alerteA, APPELANT.acteur, "Redémarré, à surveiller.");
    await inserer(B, alerteB, APPELANT.acteur, "Autre client.");
    await expect(inserer(A, alerteA, "autre-personne", "x")).rejects.toMatchObject({ code: "42501" });
    await expect(inserer(A, alerteA, APPELANT.acteur, "x".repeat(501))).rejects.toMatchObject({ code: "23514" });
    await expect(inserer(A, alerteA, APPELANT.acteur, "   ")).rejects.toMatchObject({ code: "23514" });
    await expect(inserer(A, alerteB, APPELANT.acteur, "x")).rejects.toMatchObject({ code: "23503" });
    await expect(lireSous(app, A, "UPDATE commentaires_alertes SET texte = 'x'")).rejects.toMatchObject({ code: "42501" });
    await expect(lireSous(app, A, "DELETE FROM commentaires_alertes")).rejects.toMatchObject({ code: "42501" });
    for (const [role, pool_] of [["console_app", app], ["console_lecture", lecture]] as const) {
      expect((await lireSous(pool_, A, "SELECT tenant_id FROM commentaires_alertes")).rows, role).toEqual([{ tenant_id: A }]);
    }
    // Colonnes d'alertes : à la création (INSERT) ou avec une transition vers « acquittee » ou « close » (politique transitions_alerte de la 0010, ESCALADE : une mise à jour qui garde l'état « ouverte » est refusée).
    await expect(ecrire(app, A, (c) => c.query("UPDATE alertes SET cle_regroupement = 'groupe:essai' WHERE id = $1", [alerteA]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE alertes SET cause = 'Texte Libre', etat = 'acquittee' WHERE id = $1", [alerteA]), APPELANT)).rejects.toMatchObject({ code: "23514" });
    await expect(ecrire(app, A, (c) => c.query("UPDATE alertes SET type = 'autre', etat = 'acquittee' WHERE id = $1", [alerteA]), APPELANT)).rejects.toMatchObject({ code: "42501" });
    expect((await ecrire(app, A, (c) => c.query("UPDATE alertes SET cause = 'x', etat = 'acquittee' WHERE id = $1", [alerteB]), APPELANT)).rowCount).toBe(0);
    expect((await ecrire(app, A, (c) => c.query("UPDATE alertes SET cle_regroupement = 'groupe:essai', cause = 'cause_essai', etat = 'acquittee' WHERE id = $1", [alerteA]), APPELANT)).rowCount).toBe(1);
  });

  it("[LOT5-tables] mesures_capacite : table commune non partitionnée, lue par console_app, écrite par l'équipe seule avec un acteur", async () => {
    const A = randomUUID();
    await creerOrg(A);
    expect((await migration.query("SELECT relkind FROM pg_class WHERE oid = 'public.mesures_capacite'::regclass")).rows[0]?.relkind).toBe("r");
    expect((await migration.query("SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'public.mesures_capacite'::regclass")).rows[0]?.n).toBe(0);
    const releve = "INSERT INTO mesures_capacite (debut, cible_type, cible_code, cpu_bps, memoire_octets, disque_octets) VALUES (now(), 'serveur', $1, $2, 1000, 1000)";
    const cible = `serveur_${randomUUID().slice(0, 8)}`;
    await expect(commeEquipe(null, (c) => c.query(releve, [cible, 1200]))).rejects.toMatchObject({ code: "42501" });
    await expect(commeEquipe("agent-essai", (c) => c.query(releve, [cible, 10001]))).rejects.toMatchObject({ code: "23514" });
    await commeEquipe("agent-essai", (c) => c.query(releve, [cible, 1200]));
    expect((await lireSous(app, A, `SELECT cpu_bps FROM mesures_capacite WHERE cible_code = '${cible}'`)).rows).toEqual([{ cpu_bps: 1200 }]);
    await expect(lireSous(app, A, `INSERT INTO mesures_capacite (debut, cible_type, cible_code, cpu_bps, memoire_octets, disque_octets) VALUES (now(), 'serveur', 'serveur_x', 1, 1, 1)`)).rejects.toMatchObject({ code: "42501" });
    await expect(lireSous(lecture, A, "SELECT 1 FROM mesures_capacite")).rejects.toMatchObject({ code: "42501" });
    await expect(commeEquipe("agent-essai", (c) => c.query("UPDATE mesures_capacite SET cpu_bps = 1"))).rejects.toMatchObject({ code: "42501" });
  });

  it("[LOT5-tables] invariants C5 sans écart après la migration 0023, alertes et agregats_quotidiens compris", async () => {
    const ecarts = await controlerInvariants(requete, "console", OPTIONS);
    const nouvelles = /^(incidents|regles_alertes|disjoncteurs|reveils|mesures_capacite|modeles_messages|bilans_incident|fenetres_maintenance|avis_depreciation|commentaires_alertes|alertes|agregats_quotidiens)/;
    expect(ecarts.filter((e) => nouvelles.test(e.objet))).toEqual([]);
    expect(ecarts.filter((e) => e.regle === "ecriture_commune_ouverte" || e.regle === "role_contourne_rls")).toEqual([]);
  });
});
