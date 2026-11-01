import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { avecClient } from "../db/client-actif.js";
import { migrer } from "../db/migrer.js";
import { lireJournalSql } from "../routes/journal.js";
import { contenuCanonique, type LigneJournal } from "./contenu-canonique.js";
import { lecteurSql, verifierChaine } from "./verifier.js";

// Vérification de la chaîne contre le vrai PostgreSQL du socle (job socle-integration), même méthode de connexion que base.int.test.ts.
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
const ouverts: pg.Pool[] = [];
const ouvrir = (voie: { host: string; port: number }, user: string, max: number) => {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
};
const migration = ouvrir(DIRECT, "console_migration", 2);
const app = ouvrir(PGBOUNCER, "console_app", 4);
const equipe = ouvrir(PGBOUNCER, "console_equipe", 2);
const requeteEquipe = async (sql: string, valeurs: unknown[]) => (await equipe.query(sql, valeurs)).rows as Record<string, unknown>[];
const SCHEMA = `essai_t210_${process.pid}`;
const AJOUTER = "SELECT public.audit_ajouter($1::uuid, $2, $3::public.action_audit, $4, $5, $6::jsonb, $7::jsonb) AS id";
const ecrire = (tenant: string, entite: string, entiteId: string, nouvelle: object, ip?: string) =>
  avecClient(app, tenant, (c) => c.query(AJOUTER, [tenant, "agent-essai", "insertion", entite, entiteId, null, JSON.stringify(nouvelle)]), { acteur: "agent-essai", ...(ip ? { ip } : {}) });

// Le journal de la CI n'affiche que ce qui passe par writeSync(2, …) : console.log y est avalé.
const ecrireEchec = (nom: string, e: unknown): void => { writeSync(2, `ECHEC ${nom} : ${(e instanceof Error ? `${e.name} ${e.message}` : String(e)).slice(0, 600)}\n`); };
beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) { ecrireEchec("beforeAll verifier", e); throw e; }
}, 120_000);
afterAll(async () => {
  await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await Promise.all(ouverts.map((p) => p.end().catch(() => undefined)));
});

describe("vérification de la chaîne du journal, avec le socle", { timeout: 60_000 }, () => {
  beforeEach((ctx) => { onTestFailed((c) => ecrireEchec(ctx.task.name, c.task.result?.errors?.[0])); });

  it("[C-028] la vérification d'un journal intact ne trouve aucune rupture", async () => {
    const A = randomUUID();
    for (let i = 0; i < 5; i++) await ecrire(A, "essai_t210", `e${i}`, { i, texte: "é\"\\\n" }, i % 2 ? "192.0.2.9" : undefined);
    const r = await verifierChaine(lecteurSql(requeteEquipe));
    expect(r).toMatchObject({ intacte: true });
    if (r.intacte) expect(r.lignes).toBeGreaterThanOrEqual(5);
  });

  it("[C-028] le contenu canonique calculé en TypeScript est identique à celui de PostgreSQL sur 100 lignes", async () => {
    const A = randomUUID();
    for (let i = 0; i < 100; i++) await ecrire(A, "essai_t210_canon", `e${i}`, { i, o: { b: [1, 2.5, null, true], a: "x" }, texte: i % 3 ? "é\"\\\t" : " " }, i % 4 === 0 ? "2001:db8::1" : i % 4 === 1 ? "192.0.2.77" : undefined);
    const { rows } = await migration.query(
      `SELECT id::text, public.audit_contenu(id, tenant_id, acteur, action, entite, entite_id, ancienne, nouvelle, ip, cree_le) AS sql FROM public.journal_audit WHERE tenant_id = $1 ORDER BY id`, [A]);
    const lignes = await lecteurSql(requeteEquipe).lireIntervalle("1970-01-01T00:00:00.000000Z", "2100-01-01T00:00:00.000000Z");
    const parId = new Map(lignes.map((l) => [l.id, l]));
    expect(rows).toHaveLength(100);
    for (const r of rows) expect(contenuCanonique(parId.get(r["id"] as string) as LigneJournal), r["id"] as string).toBe(r["sql"]);
  });

  it("[C-028] une ligne modifiée par le superutilisateur du test est trouvée à son identifiant", async () => {
    // Base jetable du test : une copie du journal dans un schéma à part, que le rôle de migration (propriétaire) peut modifier.
    // Le vrai journal, son déclencheur d'ajout seul et ses droits ne sont jamais touchés.
    const A = randomUUID();
    for (let i = 0; i < 6; i++) await ecrire(A, "essai_t210_copie", `e${i}`, { i });
    await migration.query(`CREATE SCHEMA ${SCHEMA}`);
    await migration.query(`CREATE TABLE ${SCHEMA}.journal_audit AS SELECT * FROM public.journal_audit`);
    const requeteCopie = async (sql: string, v: unknown[]) => (await migration.query(sql, v)).rows as Record<string, unknown>[];
    const lecteur = lecteurSql(requeteCopie, `${SCHEMA}.journal_audit`);
    expect(await verifierChaine(lecteur)).toMatchObject({ intacte: true });
    const { rows } = await migration.query(`SELECT id::text, empreinte FROM ${SCHEMA}.journal_audit WHERE tenant_id = $1 ORDER BY id`, [A]);
    const cible = rows[3]!;
    await migration.query(`UPDATE ${SCHEMA}.journal_audit SET acteur = 'forge' WHERE id = $1`, [cible["id"]]);
    expect(await verifierChaine(lecteur)).toMatchObject({ intacte: false, rupture: { id: cible["id"], trouve: cible["empreinte"] } });
  });

  it("[C-028] au-delà de 9 lignes, l'ordre suit l'identifiant numérique : 12 lignes lues dans l'ordre, chaîne intacte", async () => {
    const A = randomUUID();
    const entite = `essai_t210_ordre_${process.pid}`;
    for (let i = 0; i < 12; i++) await ecrire(A, entite, `o${i}`, { i });
    const lues = await lireJournalSql(requeteEquipe, { entite, limite: 50 });
    expect(lues.map((l) => l.entite_id)).toEqual(Array.from({ length: 12 }, (_, i) => `o${i}`));
    expect(await verifierChaine(lecteurSql(requeteEquipe))).toMatchObject({ intacte: true });
  });

  it("[C-401] le journal se lit par entité et par période", async () => {
    const A = randomUUID();
    const entite = `essai_t210_lecture_${process.pid}`;
    await ecrire(A, entite, "x1", { v: 1 });
    await ecrire(A, entite, "x2", { v: 2 });
    const tout = await lireJournalSql(requeteEquipe, { entite, limite: 50 });
    expect(tout.map((l) => l.entite_id)).toEqual(["x1", "x2"]);
    expect((await lireJournalSql(requeteEquipe, { entite, entiteId: "x2", limite: 50 })).map((l) => l.entite_id)).toEqual(["x2"]);
    expect(await lireJournalSql(requeteEquipe, { entite, du: "2000-01-01T00:00:00.000Z", au: "2000-01-02T00:00:00.000Z", limite: 50 })).toEqual([]);
    expect(await lireJournalSql(requeteEquipe, { entite, du: "2000-01-01T00:00:00.000Z", au: "2100-01-01T00:00:00.000Z", limite: 1 })).toHaveLength(1);
    expect((await lireJournalSql(requeteEquipe, { entite, apres: tout[0]!.id, limite: 50 })).map((l) => l.entite_id)).toEqual(["x2"]);
  });
});
