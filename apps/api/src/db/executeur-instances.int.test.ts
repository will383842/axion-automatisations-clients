import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Tables de suivi (T2-07) : notes, demandes (métadonnées), cellules, thèmes, outils, audits, besoins, propositions, registre des traitements. Socle lancé par ops/socle/lancer.sh (job socle-integration).
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

const app = pool(PGBOUNCER, "console_app", 40);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };

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
const unique = () => randomUUID().replaceAll("-", "").slice(0, 8);
// Écriture de l'équipe sur une table commune : une transaction avec l'acteur du journal (rejouée sur 55P03 / 40P01).
async function ecrireEquipe<T>(fn: (c: pg.PoolClient) => Promise<T>, acteur: string | null = "agent-essai"): Promise<T> {
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
const cellule = (extra: Record<string, unknown> = {}) => {
  const v = { code: `cellule-${unique()}`, adresse_interne: `cellule-${unique()}.interne.test`, mode: "mutualise", capacite: 50, nombre_instances: 3, version_image: "1.0.0", etat: "active", ...extra };
  const cles = Object.keys(v);
  return ecrireEquipe((c) => c.query(`INSERT INTO cellules (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, code`, Object.values(v)));
};

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit par writeSync(2, …), lisible dans le journal du job.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});


const creerOrg = (id: string) => ecrire(app, id, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')", [id]), APPELANT);
// À l'état pause : l'activation exige un contrat de sous-traitance (T2-05). Colonnes explicites : console_app ne lit pas toutes les colonnes d'instances.
const creerInstance = (A: string, colonnes = "", valeurs: unknown[] = []) =>
  ecrire(app, A, async (c) => (await c.query(`INSERT INTO instances (id, tenant_id, organisation_id, code_automatisation, formule, environnement, etat${colonnes}) VALUES ($1, $2, $2, 'relance-devis', 'abonnement', 'test', 'pause'${valeurs.map((_, i) => `, $${i + 3}`).join("")}) RETURNING id`, [randomUUID(), A, ...valeurs])).rows[0]?.["id"] as string, APPELANT);
const lire = (A: string, id: string) =>
  ecrire(app, A, async (c) => (await c.query("SELECT cellule_code, arret_envois, version_etat_voulu FROM instances WHERE id = $1", [id])).rows[0] as { cellule_code: string | null; arret_envois: boolean; version_etat_voulu: number }, APPELANT);
const maj = (A: string, id: string, ensemble: string, valeurs: unknown[] = []) => ecrire(app, A, (c) => c.query(`UPDATE instances SET ${ensemble} WHERE id = $1`, [id, ...valeurs]), APPELANT);

describe("liens instance → cellule et version de l'état voulu, avec le socle", { timeout: 90_000 }, () => {
  it("[C-017] une instance créée sans les nouvelles colonnes les reçoit à NULL, false et 0 (comme les lignes déjà présentes)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    expect(await lire(A, id)).toEqual({ cellule_code: null, arret_envois: false, version_etat_voulu: 0 });
  });

  it("[C-017] la version de l'état voulu monte de 1 quand l'état, l'arrêt des envois ou la cellule changent, et seulement alors", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    const { rows } = await cellule();
    const code = rows[0]?.["code"] as string;
    await maj(A, id, "etat = 'erreur'");
    expect((await lire(A, id)).version_etat_voulu).toBe(1);
    await maj(A, id, "arret_envois = true");
    expect((await lire(A, id)).version_etat_voulu).toBe(2);
    await maj(A, id, "cellule_code = $2", [code]);
    expect(await lire(A, id)).toEqual({ cellule_code: code, arret_envois: true, version_etat_voulu: 3 });
    // Rien qui concerne l'état voulu : la version ne bouge pas (même valeur réécrite, autre colonne).
    await maj(A, id, "etat = 'erreur', arret_envois = true, cellule_code = $2", [code]);
    await maj(A, id, "code_automatisation = 'autre-code'");
    expect((await lire(A, id)).version_etat_voulu).toBe(3);
    await maj(A, id, "cellule_code = NULL");
    expect((await lire(A, id)).version_etat_voulu).toBe(4);
  });

  it("[C-017] @isolation l'application n'écrit jamais la version : une valeur fournie est écrasée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    await maj(A, id, "version_etat_voulu = 99");
    expect((await lire(A, id)).version_etat_voulu).toBe(0);
    await maj(A, id, "etat = 'erreur', version_etat_voulu = 99");
    expect((await lire(A, id)).version_etat_voulu).toBe(1);
    await maj(A, id, "version_etat_voulu = -1"); // écrasée aussi : le déclencheur rend OLD + 0
    expect((await lire(A, id)).version_etat_voulu).toBe(1);
    await expect(creerInstance(A, ", version_etat_voulu", [-1])).rejects.toMatchObject({ code: "23514" }); // à l'INSERT, la contrainte garde
  });

  it("[C-017] un code de cellule avec _ ou de forme inconnue est refusé par la contrainte de forme C4", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    // cellules.code accepte _ (dette T2-52) : la cellule existe, mais l'instance ne peut pas la porter.
    const { rows } = await cellule({ code: `ab_${unique()}` });
    await expect(maj(A, id, "cellule_code = $2", [rows[0]?.["code"]])).rejects.toMatchObject({ code: "23514", constraint: "instances_cellule_code_forme_c4" });
    for (const mauvais of ["A", "-a", "a--b", "a b", "a".repeat(65)]) await expect(maj(A, id, "cellule_code = $2", [mauvais]), mauvais).rejects.toMatchObject({ code: "23514" });
  });

  it("[C-017] une cellule qui n'existe pas est refusée par la clé étrangère", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = await creerInstance(A);
    await expect(maj(A, id, "cellule_code = $2", [`absente-${unique()}`])).rejects.toMatchObject({ code: "23503", constraint: "instances_cellule_fk" });
    await expect(creerInstance(A, ", cellule_code", [`absente-${unique()}`])).rejects.toMatchObject({ code: "23503" });
  });

  it("[C-017] @isolation console_app lit les trois nouvelles colonnes mais ne lit pas la table cellules", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(ecrire(app, A, (c) => c.query("SELECT code FROM cellules LIMIT 1"), APPELANT)).rejects.toMatchObject({ code: "42501" });
    const { rows } = await cellule();
    const id = await creerInstance(A, ", cellule_code", [rows[0]?.["code"]]);
    expect((await lire(A, id)).cellule_code).toBe(rows[0]?.["code"]);
  });

  it("[C-017] @isolation l'index (id, cellule_code) existe et la fonction du déclencheur n'est ni SECURITY DEFINER ni exécutable par PUBLIC", async () => {
    const idx = await equipe.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'instances_id_cellule_idx'");
    expect(idx.rows[0]?.["indexdef"]).toMatch(/\(id, cellule_code\)/);
    const f = await equipe.query("SELECT prosecdef, proconfig, has_function_privilege('public', oid, 'EXECUTE') AS public_exec FROM pg_proc WHERE proname = 'instances_version_etat_voulu'");
    expect(f.rows[0]).toMatchObject({ prosecdef: false, public_exec: false });
    expect(f.rows[0]?.["proconfig"]).toEqual(["search_path=pg_catalog, pg_temp"]);
  });
});
