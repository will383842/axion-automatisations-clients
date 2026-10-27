import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";

// Tests contre le socle lancé par ops/socle/lancer.sh (job socle-integration), même méthode de connexion que isolation.int.test.ts :
// adresse lue sur le réseau interne (docker inspect), rôle console_migration en direct, schéma jetable.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) =>
  docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cibleDirecte(): { host: string; port: number } {
  const surcharge = process.env["SOCLE_PG_DIRECT"];
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
  return { host: docker("inspect", "-f", modele, conteneur("postgres")), port: 5432 };
}
function motDePasse(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const variables = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n");
  const ligne = variables.find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}

const BASE = "console";
const SCHEMA = "essai_unicite";
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
let migration: pg.Pool;
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];

// Une table conforme en tout sauf ce que l'essai ajoute : RLS, FORCE, politique citant tenant_id, index (tenant_id).
const table = (nom: string, colonnes: string) => `
  CREATE TABLE ${SCHEMA}.${nom} (${colonnes});
  CREATE INDEX ${nom}_tenant ON ${SCHEMA}.${nom} (tenant_id);
  ALTER TABLE ${SCHEMA}.${nom} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${SCHEMA}.${nom} FORCE ROW LEVEL SECURITY;
  CREATE POLICY isolation ON ${SCHEMA}.${nom} USING (tenant_id = current_setting('app.tenant_id')::uuid);`;
const IDENTITE = "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL";
const nettoyer = () => migration.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
// Écarts des règles d'unicité et de clés étrangères sur les seules tables d'essai.
async function ecarts(): Promise<string[]> {
  const tous = await controlerInvariants(requete, BASE, OPTIONS);
  return tous.filter((e) => e.objet.startsWith(`${SCHEMA}.`) && (e.regle === "unicite_sans_tenant" || e.regle === "etrangere_sans_tenant")).map((e) => `${e.regle} ${e.objet}`).sort();
}

describe("règles C5 d'unicité et de clés étrangères sur le vrai PostgreSQL", () => {
  beforeAll(async () => {
    const motDePasseDe = (role: string) => createHash("sha256").update(`${motDePasse()}/${role}`).digest("hex");
    migration = new pg.Pool({ ...cibleDirecte(), user: `${BASE}_migration`, database: BASE, password: motDePasseDe(`${BASE}_migration`), max: 2, connectionTimeoutMillis: 10_000 });
    migration.on("error", () => undefined);
    await nettoyer();
    await migration.query(`CREATE SCHEMA ${SCHEMA}`);
  }, 60_000);
  afterEach((ctx) => {
    for (const e of ctx.task.result?.errors ?? []) console.log(`ECHEC-UNICITE ${ctx.task.name} :: ${String(e.message).replaceAll("
", " / ")}`);
  });
  afterAll(async () => {
    await nettoyer().catch(() => undefined);
    await migration.end().catch(() => undefined);
  });

  it("[A-163] @isolation une contrainte UNIQUE posée par ALTER TABLE est vue comme un index unique", async () => {
    await migration.query(`${table("c_alter", `${IDENTITE}, courriel text NOT NULL`)} ALTER TABLE ${SCHEMA}.c_alter ADD CONSTRAINT c_alter_courriel UNIQUE (courriel)`);
    expect(await ecarts()).toEqual([`unicite_sans_tenant ${SCHEMA}.c_alter.c_alter_courriel`]);
    await migration.query(`DROP TABLE ${SCHEMA}.c_alter`);
  });

  it("[A-163] @isolation un index unique partiel ou sur expression sans tenant_id est signalé", async () => {
    await migration.query(`${table("c_partiel", `${IDENTITE}, courriel text NOT NULL, actif boolean NOT NULL`)}
      CREATE UNIQUE INDEX c_partiel_actif ON ${SCHEMA}.c_partiel (courriel) WHERE actif;
      CREATE UNIQUE INDEX c_partiel_minuscule ON ${SCHEMA}.c_partiel (lower(courriel));
      CREATE UNIQUE INDEX c_partiel_ok ON ${SCHEMA}.c_partiel (courriel, tenant_id)`);
    expect(await ecarts()).toEqual([`unicite_sans_tenant ${SCHEMA}.c_partiel.c_partiel_actif`, `unicite_sans_tenant ${SCHEMA}.c_partiel.c_partiel_minuscule`]);
    await migration.query(`DROP TABLE ${SCHEMA}.c_partiel`);
  });

  it("[A-163] @isolation une clé primaire GENERATED BY DEFAULT n'est pas exemptée", async () => {
    await migration.query(`${table("c_defaut", "id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL")}
      ${table("c_uuid", "id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL")}`);
    expect(await ecarts()).toEqual([`unicite_sans_tenant ${SCHEMA}.c_defaut.c_defaut_pkey`, `unicite_sans_tenant ${SCHEMA}.c_uuid.c_uuid_pkey`]);
    await migration.query(`DROP TABLE ${SCHEMA}.c_defaut, ${SCHEMA}.c_uuid`);
  });

  it("[A-163] @isolation une clé étrangère (tenant_id, x) vers (tenant_id, id) est acceptée, x vers id est signalée", async () => {
    await migration.query(`${table("parents", `${IDENTITE}, UNIQUE (tenant_id, id)`)}
      ${table("enfants_ok", `${IDENTITE}, parent_id bigint NOT NULL, FOREIGN KEY (tenant_id, parent_id) REFERENCES ${SCHEMA}.parents (tenant_id, id)`)}
      ${table("enfants_ko", `${IDENTITE}, parent_id bigint NOT NULL REFERENCES ${SCHEMA}.parents (id)`)}`);
    expect(await ecarts()).toEqual([`etrangere_sans_tenant ${SCHEMA}.enfants_ko.enfants_ko_parent_id_fkey`]);
    await migration.query(`DROP TABLE ${SCHEMA}.enfants_ok, ${SCHEMA}.enfants_ko, ${SCHEMA}.parents`);
  });

  it("[A-163] @isolation une clé étrangère à positions croisées (tenant_id vers autre colonne) est signalée", async () => {
    await migration.query(`${table("croise_parent", `${IDENTITE}, autre uuid NOT NULL, UNIQUE (autre, tenant_id)`)}
      ${table("croise_enfant", `${IDENTITE}, x uuid NOT NULL, FOREIGN KEY (tenant_id, x) REFERENCES ${SCHEMA}.croise_parent (autre, tenant_id)`)}`);
    expect(await ecarts()).toEqual([`etrangere_sans_tenant ${SCHEMA}.croise_enfant.croise_enfant_tenant_id_x_fkey`]);
    await migration.query(`DROP TABLE ${SCHEMA}.croise_enfant, ${SCHEMA}.croise_parent`);
  });

  it("[A-163] @isolation un index unique qui n'a tenant_id qu'en INCLUDE est signalé", async () => {
    await migration.query(`${table("c_include", `${IDENTITE}, courriel text NOT NULL`)} CREATE UNIQUE INDEX c_include_courriel ON ${SCHEMA}.c_include (courriel) INCLUDE (tenant_id)`);
    expect(await ecarts()).toEqual([`unicite_sans_tenant ${SCHEMA}.c_include.c_include_courriel`]);
    await migration.query(`DROP TABLE ${SCHEMA}.c_include`);
  });

  it("[A-163] @isolation un index unique d'une partition attachée est contrôlé comme celui d'une table", async () => {
    await migration.query(`CREATE TABLE ${SCHEMA}.executions (id bigint NOT NULL, tenant_id uuid NOT NULL, cree_le date NOT NULL, PRIMARY KEY (tenant_id, id, cree_le)) PARTITION BY RANGE (cree_le);
      CREATE TABLE ${SCHEMA}.executions_2026_10 (id bigint NOT NULL, tenant_id uuid NOT NULL, cree_le date NOT NULL, courriel text);
      CREATE UNIQUE INDEX executions_2026_10_courriel ON ${SCHEMA}.executions_2026_10 (courriel);
      ALTER TABLE ${SCHEMA}.executions ATTACH PARTITION ${SCHEMA}.executions_2026_10 FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')`);
    expect(await ecarts()).toEqual([`unicite_sans_tenant ${SCHEMA}.executions_2026_10.executions_2026_10_courriel`]);
    await migration.query(`DROP TABLE ${SCHEMA}.executions`);
  });

  // btree_gist permet l'opérateur « différent » sur uuid : EXCLUDE (tenant_id WITH <>, ressource WITH =) est un oracle (23P01) bien que tenant_id soit dans la clé.
  // Si l'image PostgreSQL n'a pas btree_gist (ou si le rôle ne peut pas le créer), l'essai porte sur le même contrôle avec un type natif :
  // tenant_id de type int4range, opérateur « && » (signalé) contre « = » (accepté). Le contrôle ne regarde que le nom de colonne et l'opérateur.
  it("[A-163] @isolation une contrainte EXCLUDE dont l'opérateur sur tenant_id n'est pas « = » est signalée, celle avec « = » est acceptée", async () => {
    let gist = false;
    try {
      await migration.query(`CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA ${SCHEMA}`);
      gist = true;
    } catch {
      gist = false;
    }
    const colonnes = gist ? "tenant_id uuid NOT NULL" : "tenant_id int4range NOT NULL";
    const ko = gist ? "EXCLUDE USING gist (tenant_id WITH <>, ressource WITH =)" : "EXCLUDE USING gist (tenant_id WITH &&)";
    const ok = gist ? "EXCLUDE USING gist (tenant_id WITH =, ressource WITH =)" : "EXCLUDE USING gist (tenant_id WITH =)";
    // Tables écrites à la main : le gabarit `table()` crée un index btree sur tenant_id, inutile ici (un range n'a pas d'index btree utile pour le contrôle).
    await migration.query(`CREATE TABLE ${SCHEMA}.c_exclu_ko (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ${colonnes}, ressource text NOT NULL, ${ko});
      CREATE TABLE ${SCHEMA}.c_exclu_ok (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ${colonnes}, ressource text NOT NULL, ${ok})`);
    const trouves = (await ecarts()).filter((e) => e.includes("c_exclu"));
    expect(trouves.length === 1 && trouves[0] === `unicite_sans_tenant ${SCHEMA}.c_exclu_ko.c_exclu_ko_${gist ? "tenant_id_ressource" : "tenant_id"}_excl`, `btree_gist ${gist ? "présent" : "absent"} : ${trouves.join(" | ")}`).toBe(true);
    await migration.query(`DROP TABLE ${SCHEMA}.c_exclu_ko, ${SCHEMA}.c_exclu_ok`);
  });
});
