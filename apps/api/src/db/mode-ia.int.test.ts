import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Migration 0026 (T4-54a) : instances.mode_ia et droits par colonne. Socle lancé par ops/socle/lancer.sh (job socle-integration).
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
const app = pool(PGBOUNCER, "console_app", 10);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if (!["55P03", "40P01"].includes((e as { code?: string }).code ?? "") || essai >= 6) throw e;
    }
  }
}
const codeErreur = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "inconnu";
  }
};
async function creerInstance(tenant: string, extra = "", valeurs: unknown[] = []): Promise<string> {
  // L'id est tiré par la base : console_app ne le fournit jamais (ADR 0111).
  return ecrire(app, tenant, async (c) => {
    await c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin') ON CONFLICT DO NOTHING", [tenant]);
    const r = await c.query(
      `INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat${extra}) VALUES ($1, $1, 'relance-devis', 'abonnement', 'test', 'pause'${valeurs.map((_, i) => `, $${i + 2}`).join("")}) RETURNING id`,
      [tenant, ...valeurs],
    );
    return r.rows[0]?.["id"] as string;
  }, APPELANT);
}
const lireMode = (tenant: string, id: string) =>
  ecrire(app, tenant, async (c) => (await c.query("SELECT mode_ia FROM instances WHERE id = $1", [id])).rows[0]?.["mode_ia"] as string | undefined, APPELANT);

beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) {
    writeSync(2, `mode-ia.int : migration impossible : ${(e as Error).message}\n`);
    throw e;
  }
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((p) => p.end()));
});

describe("instances.mode_ia (migration 0026)", () => {
  it("[C-634] une instance créée sans mode vaut via_axion, et console_app lit et écrit la colonne", async () => {
    const A = randomUUID();
    const id = await creerInstance(A);
    expect(await lireMode(A, id)).toBe("via_axion");
    await ecrire(app, A, (c) => c.query("UPDATE instances SET mode_ia = 'client_direct' WHERE id = $1", [id]), APPELANT);
    expect(await lireMode(A, id)).toBe("client_direct");
    const B = randomUUID();
    expect(await lireMode(B, await creerInstance(B, ", mode_ia", ["client_direct"]))).toBe("client_direct");
  });

  it("[C-634] une valeur hors des deux modes est refusée (23514), aussi à la modification", async () => {
    const A = randomUUID();
    expect(await codeErreur(creerInstance(A, ", mode_ia", ["relie"]))).toBe("23514");
    const id = await creerInstance(A);
    expect(await codeErreur(ecrire(app, A, (c) => c.query("UPDATE instances SET mode_ia = NULL WHERE id = $1", [id]), APPELANT))).toBe("23502");
    expect(await codeErreur(ecrire(app, A, (c) => c.query("UPDATE instances SET mode_ia = 'autre' WHERE id = $1", [id]), APPELANT))).toBe("23514");
  });

  it("[C-634] @isolation le mode d'une instance du client A est invisible et immuable depuis le client B", async () => {
    const A = randomUUID();
    const B = randomUUID();
    const id = await creerInstance(A);
    await creerInstance(B);
    await ecrire(app, B, (c) => c.query("UPDATE instances SET mode_ia = 'client_direct' WHERE id = $1", [id]), APPELANT);
    expect(await lireMode(A, id)).toBe("via_axion");
    expect(await ecrire(app, B, async (c) => (await c.query("SELECT mode_ia FROM instances WHERE id = $1", [id])).rowCount, APPELANT)).toBe(0);
  });

  it("[C-634] les droits restent par colonne : pas de DELETE, RLS forcée, mode_ia fermé à PUBLIC", async () => {
    const A = randomUUID();
    const id = await creerInstance(A);
    expect(await codeErreur(ecrire(app, A, (c) => c.query("DELETE FROM instances WHERE id = $1", [id]), APPELANT))).toBe("42501");
    const r = await migration.query(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              has_column_privilege('console_app', 'public.instances', 'mode_ia', 'SELECT') AS sel,
              has_column_privilege('console_app', 'public.instances', 'mode_ia', 'INSERT') AS ins,
              has_column_privilege('console_app', 'public.instances', 'mode_ia', 'UPDATE') AS upd,
              has_column_privilege('console_app', 'public.instances', 'prereglage_depart_id', 'SELECT') AS ferme,
              has_table_privilege('public', 'public.instances', 'SELECT') AS pub
         FROM pg_class c WHERE c.oid = 'public.instances'::regclass`,
    );
    expect(r.rows[0]).toEqual({ rls: true, force: true, sel: true, ins: true, upd: true, ferme: false, pub: false });
  });
});
