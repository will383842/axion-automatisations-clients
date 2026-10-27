import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../../apps/api/src/db/client-actif.ts";
import { creerPool } from "../../apps/api/src/plugins/base.ts";
import { controlerInvariants, type Requete } from "../../packages/contrats/src/c5/invariants.ts";

// Porte du lot 1-A (T1A-19, partie A) : depuis le client A, essayer de lire ou d'écrire le client B dans PostgreSQL À TRAVERS PgBouncer,
// par des chemins que les tests du socle (apps/api/src/db/*.int.test.ts) n'essaient pas : paramètres de démarrage, réglages persistants,
// console de PgBouncer, oracle par erreur, statistiques du planificateur, requêtes préparées partagées, contraintes d'unicité.
// Les mots de passe des rôles sont dérivés du secret de test du socle (lu dans le conteneur), jamais écrits ni affichés.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
const ipInterne = (service: string) => docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service));

// Le job ne montre pas le rapport JSON : chaque échec et le bilan du fichier vont sur la sortie d'erreur (jamais une valeur secrète).
const FICHIER = import.meta.url.split("/").pop() ?? "";
const bilan = { verts: 0, rouges: 0, attendus: 0 };
// Une erreur hors de tout test (socket, minuterie) fait échouer le job sans nommer de test : on la nomme (nom et code, jamais le message),
// et le fichier échoue en fin de course (écouter l'événement retire à Vitest son propre constat : on le rend ici).
const nonGerees: string[] = [];
for (const evenement of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(evenement, (e: unknown) => {
    const err = e instanceof Error ? e : new Error(typeof e);
    nonGerees.push(`${evenement} ${err.name}`);
    writeSync(2, `ERREUR NON GEREE ${FICHIER} (${evenement}) : ${err.name} ${(err as { code?: string }).code ?? ""} ${(err.stack ?? "").split("\n").filter((l) => l.includes("audit-1a")).slice(0, 2).map((l) => l.trim()).join(" | ")}\n`);
  });
}
afterEach((ctx) => {
  const r = ctx.task.result;
  const rouge = r?.state === "fail";
  if (ctx.task.fails) {
    if (rouge) bilan.attendus++;
    else writeSync(2, `ECHEC ${ctx.task.name}\nattendu rouge (défaut corrigé ?) mais vert\n`);
  } else if (rouge) {
    bilan.rouges++;
    writeSync(2, `ECHEC ${ctx.task.name}\n${(r.errors ?? []).map((e) => e.message).join("\n")}\n`);
  } else if (r?.state === "pass") bilan.verts++;
});
afterAll(() => {
  writeSync(2, `BILAN ${FICHIER} : ${bilan.verts} verts, ${bilan.rouges} rouges, ${bilan.attendus} défauts attendus\n`);
  if (nonGerees.length > 0) throw new Error(`erreurs hors test : ${nonGerees.join(", ")}`);
});
// Une préparation qui échoue ne passe par aucun afterEach : on l'écrit aussi.
const garder = <T>(f: () => T | Promise<T>) => async () => {
  try {
    return await f();
  } catch (e) {
    writeSync(2, `ECHEC préparation ${FICHIER}\n${e instanceof Error ? e.message : "erreur"}\n`);
    throw e;
  }
};

let secret = "";
let direct = "";
let pgbouncer = "";
const motDePasse = (role: string) => createHash("sha256").update(`${secret}/${role}`).digest("hex");
const url = (voie: "direct" | "pgbouncer", role: string, base: string, parametres = "") =>
  `postgres://${role}:${motDePasse(role)}@${voie === "direct" ? direct : pgbouncer}/${base}${parametres}`;
const ouverts: Pool[] = [];
const pool = (voie: "direct" | "pgbouncer", role: string, base: string, parametres = "") => {
  const p = creerPool(url(voie, role, base, parametres));
  ouverts.push(p);
  return p;
};
const lignes = async (p: Pool | { query: Pool["query"] }, sql: string, valeurs: unknown[] = []) => (await p.query(sql, valeurs)).rows as Record<string, unknown>[];
const codeDe = async (promesse: Promise<unknown>) => promesse.then(() => "accepte", (e: unknown) => String((e as { code?: string }).code ?? "connexion_refusee"));

beforeAll(garder(() => {
  const env = JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", conteneur("postgres"))) as string[];
  secret = env.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="))?.slice("SOCLE_PG_MOT_DE_PASSE=".length) ?? "";
  if (!secret) throw new Error("secret de test du socle introuvable");
  direct = `${ipInterne("postgres")}:5432`;
  pgbouncer = `${ipInterne("pgbouncer")}:6432`;
}), 60_000);
afterAll(async () => {
  await Promise.all(ouverts.map((p) => p.end().catch(() => undefined)));
});

const MODELE = readFileSync(new URL("../../ops/socle/postgres/modele-politique-rls.sql", import.meta.url), "utf8");
const A = "1a2b3c4d-0000-4a00-8a00-00000000000a";
const B = "1a2b3c4d-0000-4b00-8b00-00000000000b";
const MARQUEUR_B = `DONNEE-DE-B-${randomBytes(6).toString("hex")}`;
const SCHEMA = "audit_1a";

async function appliquerModele(migration: Pool, base: string, table: string) {
  const c = await migration.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('modele.schema', $1, true), set_config('modele.table', $2, true), set_config('modele.app', $3, true), set_config('modele.equipe', $4, true)", [SCHEMA, table, `${base}_app`, `${base}_equipe`]);
    await c.query(MODELE);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

describe.each(["console", "moteur"] as const)("audit 1-A · PostgreSQL à travers PgBouncer, base %s", (base) => {
  // Sur la base moteur, les mêmes essais prouvent A-166 (même isolation que la console).
  const id = (exigence: string) => (base === "moteur" ? "A-166" : exigence);
  let migration: Pool;
  let app: Pool;
  const ecrire = (tenant: string, libelle: string) => avecClient(app, tenant, (c) => c.query(`INSERT INTO ${SCHEMA}.dossiers (tenant_id, libelle) VALUES ($1, $2)`, [tenant, libelle]));

  beforeAll(garder(async () => {
    migration = pool("direct", `${base}_migration`, base);
    app = pool("pgbouncer", `${base}_app`, base);
    await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await migration.query(`CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.dossiers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, libelle text NOT NULL)`);
    await appliquerModele(migration, base, "dossiers");
    await ecrire(A, "a1");
    await ecrire(A, "a2");
    await ecrire(B, `${MARQUEUR_B}-1`);
    await ecrire(B, `${MARQUEUR_B}-2`);
  }), 60_000);
  afterAll(async () => {
    await migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  });

  it(`[${id("A-164")}] @isolation un client actif passé dans les paramètres de démarrage (options -c app.tenant_id) n'ouvre rien et ne reste sur aucune connexion`, async () => {
    const options = `?options=${encodeURIComponent(`-c app.tenant_id=${B}`)}`;
    const piege = pool("pgbouncer", `${base}_app`, base, options);
    const vu = await lignes(piege, `SELECT tenant_id::text AS t FROM ${SCHEMA}.dossiers`).then(
      (l) => l.map((x) => x["t"]),
      () => "refuse",
    );
    // PgBouncer refuse le paramètre (attendu) ; s'il le transmettait, la connexion ne verrait au mieux que ce qu'elle a choisi, jamais au-delà.
    expect(vu === "refuse" || (Array.isArray(vu) && vu.every((t) => t === B)), "paramètre de démarrage").toBe(true);
    const autres = await Promise.all(Array.from({ length: 8 }, () => lignes(app, `SELECT current_setting('app.tenant_id', true) AS t, (SELECT count(*) FROM ${SCHEMA}.dossiers)::int AS n`)));
    for (const l of autres) expect(l[0]).toMatchObject({ n: 0 });
    for (const l of autres) expect([null, ""]).toContain(l[0]?.["t"]);
  });

  it(`[${id("A-164")}] @isolation ${base}_app ne peut poser aucun réglage par défaut, ni sur son rôle, ni sur la base (ALTER ROLE / ALTER DATABASE … SET)`, async () => {
    // Variable sonde de la même famille que app.tenant_id (réglage « app.* » non déclaré) : un succès vaudrait pour app.tenant_id,
    // sans perturber les autres essais qui ouvrent des connexions en même temps (un client par défaut posé pour de vrai les fausserait).
    const tentatives = [
      `ALTER ROLE ${base}_app SET app.audit_sonde = '${B}'`,
      `ALTER ROLE CURRENT_USER SET app.audit_sonde = '${B}'`,
      `ALTER ROLE ${base}_app IN DATABASE ${base} SET app.audit_sonde = '${B}'`,
      `ALTER DATABASE ${base} SET app.audit_sonde = '${B}'`,
    ];
    const acceptees: string[] = [];
    for (const sql of tentatives) {
      if ((await codeDe(app.query(sql))) === "accepte") acceptees.push(sql);
    }
    // Remise en état avant le constat.
    for (const sql of acceptees) await app.query(sql.replace(/ SET (\S+) = .*$/, " RESET $1")).catch(() => undefined);
    expect(acceptees).toEqual([]);
  });

  it(`[${id("A-164")}] @isolation la console d'administration de PgBouncer est fermée à ${base}_app et ${base}_equipe`, async () => {
    for (const role of [`${base}_app`, `${base}_equipe`]) {
      const admin = pool("pgbouncer", role, "pgbouncer");
      expect(await codeDe(admin.query("SHOW CLIENTS")), role).not.toBe("accepte");
    }
  });

  it(`[${id("A-164")}] @isolation une condition qui lève une erreur sur les lignes de B n'est jamais évaluée sur elles (pas d'oracle par erreur)`, async () => {
    const lus = await avecClient(app, A, async (c) =>
      (await c.query(`SELECT libelle FROM ${SCHEMA}.dossiers WHERE 1 / (CASE WHEN libelle LIKE 'DONNEE-DE-B-%' THEN 0 ELSE 1 END) = 1 ORDER BY libelle`)).rows.map((r: { libelle: string }) => r.libelle),
    );
    expect(lus).toEqual(["a1", "a2"]);
    const parTri = await avecClient(app, A, async (c) => (await c.query(`SELECT libelle FROM ${SCHEMA}.dossiers ORDER BY 1 / (CASE WHEN tenant_id = $1 THEN 0 ELSE 1 END)`, [B])).rows.length);
    expect(parTri).toBe(2);
  });

  it(`[${id("A-164")}] @isolation les statistiques du planificateur (pg_stats, pg_stats_ext) ne montrent aucune valeur de B à ${base}_app`, async () => {
    await migration.query(`CREATE STATISTICS IF NOT EXISTS ${SCHEMA}.dossiers_stats (mcv) ON tenant_id, libelle FROM ${SCHEMA}.dossiers`);
    await migration.query(`ANALYZE ${SCHEMA}.dossiers`);
    const vues = await avecClient(app, A, async (c) => {
      const s = (await c.query("SELECT coalesce(json_agg(t), '[]')::text AS j FROM pg_stats t WHERE schemaname = $1", [SCHEMA])).rows[0] as { j: string };
      const x = (await c.query("SELECT coalesce(json_agg(t), '[]')::text AS j FROM pg_stats_ext t WHERE schemaname = $1", [SCHEMA])).rows[0] as { j: string };
      return `${s.j}${x.j}`;
    });
    expect(vues.includes(MARQUEUR_B), "valeur de B visible dans les statistiques").toBe(false);
    expect(vues.includes(B), "identifiant de B visible dans les statistiques").toBe(false);
  });

  it(`[${id("A-164")}] @isolation deux connexions préparent une requête du même nom à travers PgBouncer : chacune exécute la sienne`, async () => {
    const autre = pool("pgbouncer", `${base}_app`, base);
    const executer = (p: Pool, qui: string) => p.query({ name: "audit_1a_q", text: `SELECT '${qui}'::text AS qui, (SELECT count(*) FROM ${SCHEMA}.dossiers WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)::int AS n` });
    const resultats = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? executer(app, "x") : executer(autre, "y")).then((r) => [i % 2 === 0 ? "x" : "y", (r.rows[0] as { qui: string; n: number })] as const)));
    for (const [attendu, r] of resultats) expect(r).toEqual({ qui: attendu, n: 0 });
  });

  it(`[${id("A-163")}] constat : une contrainte UNIQUE sans tenant_id fait d'une insertion de A un oracle sur une valeur de B (code 23505)`, async () => {
    await migration.query(`CREATE TABLE ${SCHEMA}.comptes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, courriel text NOT NULL UNIQUE)`);
    try {
      await appliquerModele(migration, base, "comptes");
      await avecClient(app, B, (c) => c.query(`INSERT INTO ${SCHEMA}.comptes (tenant_id, courriel) VALUES ($1, 'b@exemple.fr')`, [B]));
      const essai = (courriel: string) => codeDe(avecClient(app, A, (c) => c.query(`INSERT INTO ${SCHEMA}.comptes (tenant_id, courriel) VALUES ($1, $2)`, [A, courriel])));
      // A n'a pas le droit de voir la ligne de B, mais la réponse diffère selon qu'elle existe : 23505 contre « accepte ».
      expect(await essai("b@exemple.fr")).toBe("23505");
      expect(await essai("x@exemple.fr")).toBe("accepte");
    } finally {
      await migration.query(`DROP TABLE IF EXISTS ${SCHEMA}.comptes`);
    }
  });

  // Défaut constaté (T1A-19, PR 90, 1re exécution) : aucune règle C5 ne signale une contrainte d'unicité sans tenant_id (oracle prouvé ci-dessus).
  // Correction : une règle « unicite_sans_tenant » dans packages/contrats/src/c5/invariants.ts (tout index unique d'une table à tenant_id
  // porte tenant_id, sauf la clé d'identité générée). À faire au lot 2, avant la première table métier.
  it(`[${id("A-163")}] @isolation @lot-2 les invariants C5 signalent une contrainte UNIQUE qui ne porte pas tenant_id (oracle d'existence entre clients)`, async () => {
    await migration.query(`CREATE TABLE ${SCHEMA}.comptes2 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, courriel text NOT NULL UNIQUE)`);
    try {
      await appliquerModele(migration, base, "comptes2");
      const requete: Requete = async (sql) => (await lignes(migration, `SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`))[0]?.["r"] as Record<string, unknown>[];
      const ecarts = (await controlerInvariants(requete, base, { rolesApplication: /^(console|moteur)_(app|equipe)$/ })).filter((e) => e.objet.startsWith(`${SCHEMA}.comptes2`));
      expect(ecarts.length).toBeGreaterThan(0);
    } finally {
      await migration.query(`DROP TABLE IF EXISTS ${SCHEMA}.comptes2`);
    }
  });
});
