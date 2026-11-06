import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "../db/client-actif.js";
import Fastify from "fastify";
import { migrer } from "../db/migrer.js";
import { routeIa } from "../routes/ia/cles.js";
import { listerCles } from "./cle-client.js";

// Migration 0024 (T4-34a, ADR 0117) : modèle d'IA par client et par instance, référence de la clé d'IA propre du client (cles_ia_client).
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

const creerOrg = (id: string) =>
  ecrire(app, id, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')", [id]), APPELANT);
const refDe = (tenant: string, uuid = randomUUID()) => `bao:clients/${tenant}/${uuid}`;
const poserCle = (A: string, extra: { ref?: string; fournisseur?: string; acteur?: string; cree_par?: string } = {}) =>
  ecrire(
    app,
    A,
    (c) => c.query("INSERT INTO cles_ia_client (tenant_id, id, organisation_id, fournisseur, reference_coffre, cree_par) VALUES ($1, $2, $1, $3, $4, $5) RETURNING id", [A, randomUUID(), extra.fournisseur ?? "mistral", extra.ref ?? refDe(A), extra.cree_par ?? "agent-essai"]),
    { acteur: extra.acteur ?? "agent-essai", ip: "192.0.2.17" },
  );
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "?");

beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) {
    const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message?: string; detail?: string; constraint?: string; table?: string };
    writeSync(2, `ECHEC-MIGRATION 0024 : code=${c.code ?? "?"} message=${String(c.message ?? "").slice(0, 300)} detail=${String(c.detail ?? "").slice(0, 200)} contrainte=${c.constraint ?? ""} table=${c.table ?? ""}\n`);
    throw e;
  }
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("migration 0024 : modèle d'IA et clé propre du client, avec le socle", { timeout: 120_000 }, () => {
  it("[A-020] @isolation la clé propre du client A n'est jamais utilisée pour B (clé virtuelle distincte)", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await poserCle(A);
    expect((await ecrire(app, A, (c) => c.query("SELECT count(*)::int AS n FROM cles_ia_client"))).rows[0]?.["n"]).toBe(1);
    expect((await ecrire(app, B, (c) => c.query("SELECT count(*)::int AS n FROM cles_ia_client"))).rows[0]?.["n"]).toBe(0);
    expect(await listerCles(app, B)).toEqual([]);
    // Sous B, ni lecture, ni écriture, ni désactivation de la ligne de A.
    const ligneA = (await ecrire(app, A, (c) => c.query("SELECT id FROM cles_ia_client"))).rows[0]?.["id"] as string;
    expect((await ecrire(app, B, (c) => c.query("UPDATE cles_ia_client SET etat = 'desactivee', desactivee_le = now() WHERE id = $1", [ligneA]), APPELANT)).rowCount).toBe(0);
    expect(await code(poserCle(B, { ref: refDe(A) }))).toBe("23514");
    // Sans client actif, aucune ligne.
    expect((await app.query("SELECT count(*)::int AS n FROM cles_ia_client")).rows[0]?.["n"]).toBe(0);
  });

  it("[A-364] la valeur de la clé du client n'apparaît ni en base, ni dans les journaux, ni dans la réponse de l'API (marqueur unique)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const marqueur = `essai-cle-${randomUUID()}`;
    const journal: string[] = [];
    const serveur = Fastify({ logger: false });
    routeIa(serveur, {
      interrupteurOuvert: true,
      exigerEquipe: async () => undefined,
      contexte: async () => ({ tenantId: A, acteur: "agent-essai" }),
      coffre: { async rangerIdentifiant(tenantId: string, nom: string, valeur: string) { journal.push(`${nom}:${valeur.length}`); return refDe(tenantId); } },
      pool: app,
    });
    const r = await serveur.inject({ method: "POST", url: "/api/console/v1/ia/cles", payload: { organisationId: A, fournisseur: "mistral", valeur: marqueur } });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toContain(marqueur);
    expect(JSON.stringify(journal)).not.toContain(marqueur);
    const colonnes = (await migration.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('cles_ia_client', 'journal_audit') AND data_type IN ('text', 'jsonb', 'character varying')")).rows;
    for (const { table_name, column_name } of colonnes) {
      const n = (await migration.query(`SELECT count(*)::int AS n FROM ${table_name} WHERE ${column_name}::text LIKE $1`, [`%${marqueur}%`])).rows[0]?.["n"];
      expect(n, `${table_name}.${column_name}`).toBe(0);
    }
    await serveur.close();
  });

  it("[LOT4-ia] cles_ia_client : une référence d'un autre client est refusée", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    expect(await code(poserCle(A, { ref: refDe(B) }))).toBe("23514");
    for (const ref of [`bao:clients/${A}/../${randomUUID()}`, `bao:clients/${A}/%2e%2e`, `bao:clients/${A}/*`, `${refDe(A)}/suite`, `${refDe(A)}x`, `bao:technique/${A}/${randomUUID()}`]) {
      expect(await code(poserCle(A, { ref })), ref).toBe("23514");
    }
    expect(await code(poserCle(A))).toBe("ok");
  });

  it("[LOT4-ia] cles_ia_client : une clé désactivée ne se réactive pas", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = (await poserCle(A)).rows[0]?.["id"] as string;
    const maj = (sql: string) => ecrire(app, A, (c) => c.query(sql, [id]), APPELANT);
    expect((await maj("UPDATE cles_ia_client SET etat = 'desactivee', desactivee_le = now() WHERE id = $1")).rowCount).toBe(1);
    expect((await maj("UPDATE cles_ia_client SET etat = 'active', desactivee_le = NULL WHERE id = $1")).rowCount).toBe(0);
    expect(await code(maj("DELETE FROM cles_ia_client WHERE id = $1"))).toBe("42501");
    expect(await code(maj("UPDATE cles_ia_client SET reference_coffre = reference_coffre WHERE id = $1"))).toBe("42501");
    expect(await code(maj("TRUNCATE cles_ia_client"))).toBe("42501");
  });

  it("[LOT4-ia] cles_ia_client : deux clés vivantes pour le même fournisseur sont refusées", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = (await poserCle(A)).rows[0]?.["id"] as string;
    expect(await code(poserCle(A))).toBe("23505");
    expect(await code(poserCle(A, { fournisseur: "autre" }))).toBe("ok");
    await ecrire(app, A, (c) => c.query("UPDATE cles_ia_client SET etat = 'desactivee', desactivee_le = now() WHERE id = $1", [id]), APPELANT);
    expect(await code(poserCle(A))).toBe("ok");
  });

  it("[LOT4-ia] cles_ia_client : création sans acteur refusée, et cree_par différent de l'acteur refusé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const sansActeur = ecrire(app, A, (c) => c.query("INSERT INTO cles_ia_client (tenant_id, id, organisation_id, fournisseur, reference_coffre, cree_par) VALUES ($1, $2, $1, 'mistral', $3, 'agent-essai')", [A, randomUUID(), refDe(A)]));
    expect(await code(sansActeur)).toBe("42501");
    expect(await code(poserCle(A, { cree_par: "quelqu-un-d-autre" }))).toBe("42501");
  });

  it("[LOT4-ia] instances.modele_ia : un texte hors forme est refusé", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const instance = (await ecrire(app, A, (c) => c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'relance-devis', 'abonnement', 'test', 'pause') RETURNING id", [A]), APPELANT)).rows[0]?.["id"] as string;
    const poser = (valeur: string) => ecrire(app, A, (c) => c.query("UPDATE instances SET modele_ia = $1 WHERE id = $2", [valeur, instance]), APPELANT);
    for (const mauvais of ["", "Majuscule", "a..b", "x y", "a".repeat(129), "-debut"]) expect(await code(poser(mauvais)), mauvais).toBe("23514");
    expect(await code(poser("mistral/mistral-moyen"))).toBe("ok");
    expect((await ecrire(app, A, (c) => c.query("SELECT modele_ia FROM instances WHERE id = $1", [instance]))).rows[0]?.["modele_ia"]).toBe("mistral/mistral-moyen");
    // Le modèle par défaut du client suit la même forme.
    expect(await code(ecrire(app, A, (c) => c.query("UPDATE organisations SET modele_ia_defaut = 'A..b' WHERE id = $1", [A]), APPELANT))).toBe("23514");
  });

  it("[LOT4-ia] invariants C5 sans écart après la migration", async () => {
    const ecarts = await controlerInvariants(requete, "console", OPTIONS);
    expect(ecarts.filter((e) => /^(cles_ia_client|instances|organisations)/.test(e.objet))).toEqual([]);
    expect(ecarts.filter((e) => e.regle === "role_contourne_rls")).toEqual([]);
  });
});
