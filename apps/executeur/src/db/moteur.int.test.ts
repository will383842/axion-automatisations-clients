import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.ts";
import { verifierDossier } from "../../../../scripts/garde-migrations.ts";
import { avecClient, securiserPartitions } from "./connexion.ts";
import { chiffrerSortie, dechiffrerSortie, type Chiffreur } from "./chiffrer-sortie.ts";
import { purger } from "./purge.ts";

// Base moteur avec le socle lancé par ops/socle/lancer.sh (job socle-integration). Identifiants de client tirés au hasard : les essais partagent la base.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined): { host: string; port: number } {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur(service)), port };
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
function pool(voie: { host: string; port: number }, user: string, database: string, max = 4): pg.Pool {
  const p = new pg.Pool({ ...voie, user, database, password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}
const migration = pool(DIRECT, "moteur_migration", "moteur", 2);
const app = pool(PGBOUNCER, "moteur_app", "moteur", 10);
const purge = pool(DIRECT, "moteur_purge", "moteur", 2);
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];

// g : un échec d'essai est écrit sur la sortie d'erreur, lisible dans le journal du job même si le rapporteur le tait.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

beforeAll(async () => {
  const dossier = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const refus = verifierDossier(dossier);
  if (refus.length) throw new Error(`migrations refusées :\n${refus.join("\n")}`);
  const c = await migration.connect();
  try {
    await migrate(drizzle(c), { migrationsFolder: dossier, migrationsSchema: "public", migrationsTable: "__migrations" });
    await securiserPartitions(c);
  } finally {
    c.release();
  }
}, 120_000);

// Les 11 écarts de l'outil pg_partman (objet + règle), relevés sur la base moteur migrée : 4 + 4 + 3. Liste fermée.
const OUTIL_PARTMAN = new Set(
  ["part_config", "part_config_sub"].flatMap((t) => ["tenant_id_absent", "rls_absente", "force_rls_absent", "index_tenant_absent"].map((r) => `partman.${t} ${r}`)).concat(
    ["rls_absente", "force_rls_absent", "index_tenant_absent"].map((r) => `partman.template_public_executions ${r}`),
  ),
);

const H = 3_600_000;
async function execution(tenant: string, o: { instance?: string; issue?: "reussite" | "erreur"; ageFin?: number } = {}) {
  const id = randomUUID();
  const debut = new Date(Date.now() - (o.ageFin ?? 0) - 60_000);
  await avecClient(app, tenant, async (c) => {
    await c.query("INSERT INTO executions (tenant_id, id, instance_id, automatisation, debut) VALUES ($1, $2, $3, 'relance-devis', $4)", [tenant, id, o.instance ?? randomUUID(), debut]);
    if (o.issue) await c.query("UPDATE executions SET fin = $4, issue = $3 WHERE tenant_id = $1 AND id = $2 AND debut = $5", [tenant, id, o.issue, new Date(Date.now() - (o.ageFin ?? 0)), debut]);
  });
  return { id, debut };
}
const existe = async (tenant: string, id: string) => (await avecClient(app, tenant, (c) => c.query("SELECT 1 FROM executions WHERE id = $1", [id]))).rowCount === 1;

// Une étape et une intention (écrite puis « faite », comme le fait le moteur) rattachées à une exécution.
async function etapeEtIntention(tenant: string, e: { id: string; debut: Date }, faite = true) {
  await avecClient(app, tenant, async (c) => {
    await c.query("INSERT INTO journal_etape (tenant_id, id, execution_id, debut_execution, etape, cle, statut) VALUES ($1, $2, $3, $4, 'envoi', $5, 'en_cours')", [tenant, randomUUID(), e.id, e.debut, randomUUID()]);
    const intention = randomUUID();
    await c.query("INSERT INTO intentions (tenant_id, id, execution_id, debut_execution, cle_intention, garantie, etat) VALUES ($1, $2, $3, $4, $5, 'au_plus_une_fois', 'ecrite')", [tenant, intention, e.id, e.debut, randomUUID()]);
    if (faite) await c.query("UPDATE intentions SET etat = 'faite' WHERE tenant_id = $1 AND id = $2", [tenant, intention]);
  });
}
const lignes = async (tenant: string, id: string) => {
  const n = async (table: string) => (await avecClient(app, tenant, (c) => c.query(`SELECT 1 FROM ${table} WHERE execution_id = $1`, [id]))).rowCount;
  return { etapes: await n("journal_etape"), intentions: await n("intentions") };
};

// Chiffreur factice (une clé AES par client, le client lié au chiffré) : le vrai branchement de enveloppe.ts reste à faire (ADR 0101).
function chiffreurFactice(): Chiffreur {
  const cles = new Map<string, Buffer>();
  const cle = (t: string) => cles.get(t) ?? (cles.set(t, randomBytes(32)), cles.get(t) as Buffer);
  return {
    async chiffrer(tenantId, octets) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", cle(tenantId), iv);
      c.setAAD(Buffer.from(tenantId));
      return { chiffre: Buffer.concat([iv, c.update(octets), c.final(), c.getAuthTag()]), cleChiffree: "vault:v1:AAAA", version: 1 };
    },
    async dechiffrer(tenantId, e) {
      const d = createDecipheriv("aes-256-gcm", cle(tenantId), e.chiffre.subarray(0, 12));
      d.setAAD(Buffer.from(tenantId));
      d.setAuthTag(e.chiffre.subarray(e.chiffre.length - 16));
      return Buffer.concat([d.update(e.chiffre.subarray(12, e.chiffre.length - 16)), d.final()]);
    },
  };
}

describe("base moteur, avec le socle", { timeout: 30_000 }, () => {
  it("[A-053] @isolation les invariants C5 ne signalent aucun écart sur la base moteur (partitions comprises)", async () => {
    const ecarts = await controlerInvariants(requete, "moteur", { rolesApplication: /^(console|moteur)_(app|equipe|purge)$/ });
    // Les seuls écarts écartés sont ceux des 3 tables d'outil de pg_partman, nommées une à une avec la règle (objet + règle, jamais un préfixe) : ADR 0101, point 4.
    // Aucun contrôle n'est désactivé : tout autre écart, y compris une autre règle sur ces 3 tables ou une 4e table partman, fait échouer l'essai.
    const hors = ecarts.filter((e) => !OUTIL_PARTMAN.has(`${e.objet} ${e.regle}`));
    writeSync(2, `C5 moteur : ${ecarts.length} écarts, dont ${ecarts.length - hors.length} écartés (outil partman) : ${ecarts.map((e) => `${e.objet}/${e.regle}`).join(", ")}\n`);
    expect(hors).toEqual([]);
    // Ce qui justifie l'exception : ces tables sont vides, et ni l'application, ni l'équipe, ni la purge n'ont de droit dessus.
    for (const t of ["part_config", "part_config_sub", "template_public_executions"]) {
      const droits = await requete(`SELECT r.rolname, has_table_privilege(r.rolname, 'partman.${t}', 'SELECT,INSERT,UPDATE,DELETE') AS droit FROM pg_roles r WHERE r.rolname IN ('moteur_app', 'moteur_equipe', 'moteur_purge')`);
      expect(droits.filter((d) => d["droit"]), t).toEqual([]);
    }
    expect(await requete("SELECT 1 FROM partman.template_public_executions")).toEqual([]);
    // Les partitions de executions sont bien dans le champ du contrôle : elles existent, elles ont la RLS forcée et une politique.
    const partitions = await requete(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'public.executions'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
      AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`);
    expect(partitions.length).toBeGreaterThanOrEqual(8);
  });

  it("[A-312] @isolation le client A ne lit pas le journal d'étapes du client B ; sans set_config, zéro ligne", async () => {
    const A = randomUUID();
    const B = randomUUID();
    const eB = await execution(B);
    await avecClient(app, B, (c) => c.query("INSERT INTO journal_etape (tenant_id, id, execution_id, debut_execution, etape, cle, statut) VALUES ($1, $2, $3, $4, 'envoi', 'cle-b', 'en_cours')", [B, randomUUID(), eB.id, eB.debut]));
    expect((await avecClient(app, A, (c) => c.query("SELECT 1 FROM journal_etape"))).rowCount).toBe(0);
    expect((await avecClient(app, B, (c) => c.query("SELECT 1 FROM journal_etape"))).rowCount).toBe(1);
    const sans = await app.connect();
    try {
      expect((await sans.query("SELECT 1 FROM journal_etape")).rowCount).toBe(0);
      await expect(sans.query("INSERT INTO executions (tenant_id, id, instance_id, automatisation, debut) VALUES ($1, $2, $3, 'x', now())", [A, randomUUID(), randomUUID()])).rejects.toMatchObject({ code: "42501" });
    } finally {
      sans.release();
    }
    // Écrire pour un autre client que le client actif est refusé.
    await expect(avecClient(app, A, (c) => c.query("INSERT INTO executions (tenant_id, id, instance_id, automatisation, debut) VALUES ($1, $2, $3, 'x', now())", [B, randomUUID(), randomUUID()]))).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-312] une insertion directe en état final est refusée", async () => {
    const A = randomUUID();
    const e = await execution(A);
    await expect(avecClient(app, A, (c) => c.query("INSERT INTO executions (tenant_id, id, instance_id, automatisation, debut, fin, issue) VALUES ($1, $2, $3, 'x', now(), now(), 'reussite')", [A, randomUUID(), randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    await expect(avecClient(app, A, (c) => c.query("INSERT INTO journal_etape (tenant_id, id, execution_id, debut_execution, etape, cle, statut) VALUES ($1, $2, $3, $4, 'e', 'k', 'reussie')", [A, randomUUID(), e.id, e.debut]))).rejects.toMatchObject({ code: "42501" });
    await expect(avecClient(app, A, (c) => c.query("INSERT INTO intentions (tenant_id, id, execution_id, debut_execution, cle_intention, garantie, etat) VALUES ($1, $2, $3, $4, 'i1', 'au_plus_une_fois', 'faite')", [A, randomUUID(), e.id, e.debut]))).rejects.toMatchObject({ code: "42501" });
  });

  it("[A-313] la sortie passe par chiffrerSortie : l'octet relu en base n'est pas le JSON en clair et ne se relit qu'avec la clé du client", async () => {
    const A = randomUUID();
    const e = await execution(A);
    const chiffreur = chiffreurFactice();
    const sortie = { identifiant: "dossier-4521", code: "devis_envoye", nombre: 3 };
    const ligne = await chiffrerSortie(chiffreur, A, sortie);
    await avecClient(app, A, (c) => c.query("INSERT INTO journal_etape (tenant_id, id, execution_id, debut_execution, etape, cle, statut, sortie_chiffree, sortie_cle, sortie_version) VALUES ($1, $2, $3, $4, 'e', 'k', 'en_cours', $5, $6, $7)", [A, randomUUID(), e.id, e.debut, ligne.sortieChiffree, ligne.sortieCle, ligne.sortieVersion]));
    const { rows } = await avecClient(app, A, (c) => c.query("SELECT sortie_chiffree, sortie_cle, sortie_version, pg_typeof(sortie_chiffree)::text AS type FROM journal_etape"));
    expect(rows[0]).toMatchObject({ type: "bytea" });
    const relu = rows[0].sortie_chiffree as Buffer;
    expect(relu.toString("utf8")).not.toContain("dossier-4521");
    expect(relu.equals(Buffer.from(JSON.stringify(sortie)))).toBe(false);
    expect(await dechiffrerSortie(chiffreur, A, { sortieChiffree: relu, sortieCle: rows[0].sortie_cle, sortieVersion: rows[0].sortie_version })).toEqual(sortie);
    // Le chiffré d'un client ne se relit pas avec la clé d'un autre.
    await expect(dechiffrerSortie(chiffreur, randomUUID(), { sortieChiffree: relu, sortieCle: rows[0].sortie_cle, sortieVersion: rows[0].sortie_version })).rejects.toBeDefined();
  });

  it("[C-021] une réussite de 25 h est purgée avec ses étapes et ses intentions faites, une de 23 h reste ; une erreur de 6 jours reste, de 8 jours est purgée ; une exécution sous gel reste", async () => {
    const A = randomUUID();
    const gelee = randomUUID();
    const r25 = await execution(A, { issue: "reussite", ageFin: 25 * H });
    const r23 = await execution(A, { issue: "reussite", ageFin: 23 * H });
    const e6 = await execution(A, { issue: "erreur", ageFin: 6 * 24 * H });
    const e8 = await execution(A, { issue: "erreur", ageFin: 8 * 24 * H });
    const g = await execution(A, { issue: "reussite", ageFin: 30 * H, instance: gelee });
    const enCours = await execution(A, { ageFin: 40 * H });
    const toutes = [r25, r23, e6, e8, g, enCours];
    for (const x of toutes) await etapeEtIntention(A, x);
    for (const x of toutes) expect(await lignes(A, x.id), "avant la purge").toEqual({ etapes: 1, intentions: 1 });
    // Les clés étrangères NO ACTION ne bloquent pas l'instruction (23503) : les enfants et le parent partent dans la même instruction.
    const resultat = await purger(purge, { lireGel: async () => new Set([gelee]) });
    expect(resultat.arret).toBeUndefined();
    expect(resultat.purgees).toBeGreaterThanOrEqual(2);
    for (const x of [r25, e8]) {
      expect(await existe(A, x.id)).toBe(false);
      expect(await lignes(A, x.id), "étapes et intentions purgées avec l'exécution").toEqual({ etapes: 0, intentions: 0 });
    }
    for (const x of [r23, e6, g, enCours]) {
      expect(await existe(A, x.id)).toBe(true);
      expect(await lignes(A, x.id), "étapes et intentions conservées").toEqual({ etapes: 1, intentions: 1 });
    }
  });

  it("[C-021] moteur_purge ne peut supprimer ni une exécution en cours, ni une intention écrite ou à trancher (politiques RESTRICTIVE en DELETE)", async () => {
    const A = randomUUID();
    const enCours = await execution(A);
    const finie = await execution(A, { issue: "reussite", ageFin: 48 * H });
    await avecClient(app, A, async (c) => {
      for (const etat of ["ecrite", "a_trancher"]) {
        const id = randomUUID();
        await c.query("INSERT INTO intentions (tenant_id, id, execution_id, debut_execution, cle_intention, garantie, etat) VALUES ($1, $2, $3, $4, $5, 'au_plus_une_fois', 'ecrite')", [A, id, finie.id, finie.debut, randomUUID()]);
        if (etat === "a_trancher") await c.query("UPDATE intentions SET etat = 'a_trancher' WHERE tenant_id = $1 AND id = $2", [A, id]);
      }
    });
    const suppressions = await Promise.all([
      purge.query("DELETE FROM executions WHERE tenant_id = $1 AND id = $2", [A, enCours.id]),
      purge.query("DELETE FROM intentions WHERE tenant_id = $1 AND execution_id = $2", [A, finie.id]),
    ]);
    expect(suppressions.map((r) => r.rowCount)).toEqual([0, 0]);
    expect(await existe(A, enCours.id)).toBe(true);
    expect((await lignes(A, finie.id)).intentions).toBe(2);
  });

  it("[C-021] gel illisible → la purge ne supprime rien", async () => {
    const A = randomUUID();
    const vieille = await execution(A, { issue: "reussite", ageFin: 48 * H });
    const resultat = await purger(purge, { lireGel: async () => { throw new Error("gel inaccessible"); } });
    expect(resultat).toEqual({ purgees: 0, arret: "gel_illisible" });
    expect(await existe(A, vieille.id)).toBe(true);
  });

  it("[C-021] une exécution qui garde une intention non terminée n'est pas purgée (anti-doublon de dernier recours)", async () => {
    const A = randomUUID();
    const e = await execution(A, { issue: "reussite", ageFin: 48 * H });
    await avecClient(app, A, (c) => c.query("INSERT INTO intentions (tenant_id, id, execution_id, debut_execution, cle_intention, garantie, etat) VALUES ($1, $2, $3, $4, $5, 'au_plus_une_fois', 'ecrite')", [A, randomUUID(), e.id, e.debut, randomUUID()]));
    await purger(purge, { lireGel: async () => new Set() });
    expect(await existe(A, e.id)).toBe(true);
  });

  it("[C-415] moteur_purge ne peut pas se connecter à console, keycloak ni passerelle_ia (42501), et n'a CONNECT que sur moteur", async () => {
    for (const base of ["console", "keycloak", "passerelle_ia"]) {
      const c = new pg.Client({ ...DIRECT, user: "moteur_purge", database: base, password: motDePasseDe("moteur_purge"), connectionTimeoutMillis: 10_000 });
      c.on("error", () => undefined);
      await expect(c.connect(), base).rejects.toMatchObject({ code: "42501" });
      await c.end().catch(() => undefined);
    }
    // Les bases cli_<id> vivent dans l'autre grappe (lot 2b) : aucune n'existe ici, donc rien à ouvrir. Le droit CONNECT est relu sur toutes les bases de cette grappe (ADR 0101, point 6).
    const { rows } = await migration.query("SELECT datname FROM pg_database WHERE has_database_privilege('moteur_purge', oid, 'CONNECT') AND datname NOT LIKE 'template%' ORDER BY 1");
    expect(rows.map((r) => r.datname)).toEqual(["moteur"]);
    expect((await migration.query("SELECT 1 FROM pg_database WHERE datname LIKE 'cli\\_%'")).rowCount).toBe(0);
  });
});
