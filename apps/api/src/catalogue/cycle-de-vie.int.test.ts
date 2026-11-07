import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avecClient } from "../db/client-actif.js";
import { migrer } from "../db/migrer.js";
import { journalEchecs } from "../provisionnement/journal-echecs.js";

// Migration 0027 (T4-27a, ADR 0122) sur le socle lancé par ops/socle/lancer.sh (job socle-integration). Pas de Docker en routine : écrit pour la CI.
// Les échecs sont journalisés sans secret (writeSync sur la sortie d'erreur, journal-echecs.ts).
journalEchecs(import.meta.url);
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
const ouverts: { end(): Promise<void> }[] = [];
function pool(voie: { host: string; port: number }, user: string, max: number): pg.Pool {
  const p = new pg.Pool({ ...voie, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  ouverts.push(p);
  return p;
}
const migration = pool(DIRECT, "console_migration", 2);
const equipe = pool(PGBOUNCER, "console_equipe", 4);
const app = pool(PGBOUNCER, "console_app", 4);
const ACTEUR = "equipe-cycle-essai";

const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
const lettres = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const codeErreur = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "inconnu";
  }
};
const messageErreur = async (p: Promise<unknown>) => {
  try {
    await p;
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
// Une transaction de l'équipe : jamais app.tenant_id (audit_ecrire_equipe le refuse), toujours app.acteur.
async function enEquipe<T>(fn: (c: pg.PoolClient) => Promise<T>, acteur = ACTEUR): Promise<T> {
  const c = await equipe.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', $1, true)", [acteur]);
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
// Le propriétaire des tables (les déclencheurs valent aussi pour lui).
async function enProprietaire<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await migration.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE console_proprietaire");
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
async function creerVersion(statut: "brouillon" | "recette" | "pilote" | "publiee" = "brouillon"): Promise<{ id: string; empreinte: string }> {
  const empreinte = hex();
  const code = `${lettres(4)}-${Math.floor(100 + Math.random() * 900)}`;
  const id = await enEquipe(async (c) => {
    const a = (await c.query("INSERT INTO automatisations (code, nom, statut) VALUES ($1, 'module-essai', 'en_construction') RETURNING id", [code])).rows[0]?.["id"] as string;
    return (await c.query("INSERT INTO versions_automatisation (automatisation_id, semver, api_moteur, artefact_ref, empreinte_sha256, signature_ed25519, sbom_ref) VALUES ($1, '1.0.0', '^0.1.0', $2, $3, 'c2lnbmF0dXJlLWZpY3RpdmU=', 'sbom/essai') RETURNING id", [a, `modules/${empreinte}/`, empreinte])).rows[0]?.["id"] as string;
  });
  const chemin: Record<string, string[]> = { brouillon: [], recette: ["recette"], pilote: ["recette", "pilote"], publiee: ["recette", "pilote", "publiee"] };
  for (const s of chemin[statut] ?? []) await enEquipe((c) => c.query("UPDATE versions_automatisation SET statut = $2 WHERE id = $1", [id, s]));
  return { id, empreinte };
}
const passage = (c: pg.PoolClient, v: { id: string; empreinte: string }, depart: string, arrivee: string, extra = "", valeurs: unknown[] = [], auteur = ACTEUR) =>
  c.query(`INSERT INTO passages_version (version_id, statut_depart, statut_arrivee, empreinte_sha256, auteur${extra}) VALUES ($1, $2, $3, $4, $5${valeurs.map((_, i) => `, $${i + 6}`).join("")})`, [v.id, depart, arrivee, v.empreinte, auteur, ...valeurs]);
const preuve = (c: pg.PoolClient, v: { id: string; empreinte: string }, etape: number, contenu: unknown = {}, extra = "", valeurs: unknown[] = [], auteur = ACTEUR) =>
  c.query(`INSERT INTO preuves_procedure (version_id, etape, empreinte_sha256, auteur, contenu${extra}) VALUES ($1, $2, $3, $4, $5${valeurs.map((_, i) => `, $${i + 6}`).join("")})`, [v.id, etape, v.empreinte, auteur, JSON.stringify(contenu), ...valeurs]);

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((p) => p.end()));
});

describe("cycle de vie des versions (migration 0027)", () => {
  it("[A-305] @isolation la base refuse brouillon → publiee, dans versions_automatisation comme dans passages_version", async () => {
    const v = await creerVersion();
    expect(await codeErreur(enEquipe((c) => c.query("UPDATE versions_automatisation SET statut = 'publiee' WHERE id = $1", [v.id])))).not.toBe("ok");
    expect(await codeErreur(enEquipe((c) => passage(c, v, "brouillon", "publiee")))).toBe("23514");
    expect(await codeErreur(enEquipe((c) => passage(c, v, "brouillon", "recette")))).toBe("ok");
  });

  it("[A-306] @isolation une version pilote ou publiée refuse toute modification de modeles_testes", async () => {
    for (const s of ["pilote", "publiee"] as const) {
      const v = await creerVersion(s);
      expect(await messageErreur(enEquipe((c) => c.query("UPDATE versions_automatisation SET modeles_testes = '{modele-a}' WHERE id = $1", [v.id])))).toMatch(/immuable/);
    }
  });

  it("[C-202] @isolation modeles_testes se remplit en recette, mais pas dans le même UPDATE qu'un changement de statut", async () => {
    const v = await creerVersion("recette");
    expect(await messageErreur(enEquipe((c) => c.query("UPDATE versions_automatisation SET statut = 'pilote', modeles_testes = '{modele-a}' WHERE id = $1", [v.id])))).toMatch(/aucune autre colonne/);
    await enEquipe((c) => c.query("UPDATE versions_automatisation SET modeles_testes = '{modele-a,modele-b}' WHERE id = $1", [v.id]));
    await enEquipe((c) => c.query("UPDATE versions_automatisation SET modeles_testes = '{}' WHERE id = $1", [v.id]));
    for (const mauvais of ["{NULL}", "{A}", "{a..b}"]) {
      expect(await codeErreur(enEquipe((c) => c.query("UPDATE versions_automatisation SET modeles_testes = $2::text[] WHERE id = $1", [v.id, mauvais]))), mauvais).toBe("23514");
    }
    const dix_sept = `{${Array.from({ length: 17 }, (_, i) => `m${i}`).join(",")}}`;
    expect(await codeErreur(enEquipe((c) => c.query("UPDATE versions_automatisation SET modeles_testes = $2::text[] WHERE id = $1", [v.id, dix_sept])))).toBe("23514");
    await enEquipe((c) => c.query("UPDATE versions_automatisation SET statut = 'pilote' WHERE id = $1", [v.id]));
  });

  it("[C-240] @isolation preuves_procedure est en ajout seul : UPDATE, DELETE et TRUNCATE refusés à console_equipe, DELETE refusé au propriétaire", async () => {
    const v = await creerVersion();
    await enEquipe((c) => preuve(c, v, 1));
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 1)))).toBe("23505");
    expect(await codeErreur(enEquipe((c) => c.query("UPDATE preuves_procedure SET reference = 'x' WHERE version_id = $1", [v.id])))).toBe("42501");
    expect(await codeErreur(enEquipe((c) => c.query("DELETE FROM preuves_procedure WHERE version_id = $1", [v.id])))).toBe("42501");
    expect(await codeErreur(enEquipe((c) => c.query("TRUNCATE preuves_procedure")))).toBe("42501");
    // Le propriétaire est soumis à la RLS forcée (aucune politique pour lui) : son DELETE ne touche aucune ligne ; le déclencheur refuse en plus tout DELETE sans RLS (superutilisateur, rejeu local).
    expect((await enProprietaire((c) => c.query("DELETE FROM preuves_procedure WHERE version_id = $1", [v.id]))).rowCount).toBe(0);
    expect((await enEquipe((c) => c.query("SELECT 1 FROM preuves_procedure WHERE version_id = $1 AND etape = 1", [v.id]))).rowCount).toBe(1);
    const gardes = await migration.query("SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'catalogue_garde' AND c.relname IN ('passages_version', 'preuves_procedure') AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8 AND t.tgenabled = 'O' ORDER BY 1");
    expect(gardes.rows.map((r) => r["relname"])).toEqual(["passages_version", "preuves_procedure"]);
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 11)))).toBe("23514");
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 7)))).toBe("23514");
    await enEquipe((c) => preuve(c, v, 7, {}, ", mesure_ms", [850]));
    expect(await codeErreur(enEquipe((c) => c.query("INSERT INTO preuves_procedure (version_id, etape, empreinte_sha256, auteur, contenu) VALUES ($1, 2, $2, $3, '[]'::jsonb)", [v.id, v.empreinte, ACTEUR])))).toBe("23514");
    await enEquipe((c) => passage(c, v, "brouillon", "recette"));
    expect((await enProprietaire((c) => c.query("DELETE FROM passages_version WHERE version_id = $1", [v.id]))).rowCount).toBe(0);
  });

  it("[C-240] @isolation l'auteur d'une preuve ou d'un passage est l'acteur de la transaction", async () => {
    const v = await creerVersion();
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 2, {}, "", [], "quelqu-un-d-autre")))).toBe("42501");
    expect(await codeErreur(enEquipe((c) => passage(c, v, "brouillon", "recette", "", [], "quelqu-un-d-autre")))).toBe("42501");
    await enEquipe((c) => preuve(c, v, 2));
    await enEquipe((c) => passage(c, v, "brouillon", "recette"));
  });

  it("[C-249] @isolation console_equipe ne peut pas antidater un passage en pilote", async () => {
    const v = await creerVersion("recette");
    expect(await codeErreur(enEquipe((c) => passage(c, v, "recette", "pilote", ", passe_le", [new Date(Date.now() - 8 * 86_400_000).toISOString()])))).toBe("42501");
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 3, {}, ", cree_le", [new Date(0).toISOString()])))).toBe("42501");
    await enEquipe((c) => passage(c, v, "recette", "pilote"));
    const r = await enEquipe((c) => c.query("SELECT passe_le >= now() - interval '1 minute' AS recent FROM passages_version WHERE version_id = $1", [v.id]));
    expect(r.rows[0]?.["recent"]).toBe(true);
  });

  it("[C-240] @isolation une preuve dont le contenu porte une clé « client », une adresse e-mail ou un SIREN est refusée", async () => {
    const v = await creerVersion();
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 1, { client_pilote: "x" })))).toBe("23514");
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 1, { note: "ecrire a jean@exemple.fr" })))).toBe("23514");
    expect(await codeErreur(enEquipe((c) => preuve(c, v, 1, { note: "123456782" })))).toBe("23514");
    await enEquipe((c) => preuve(c, v, 1, { probleme: "relances", minutes_par_element: 12 }));
  });

  it("[B-462] @isolation un retrait exige remplaçante et prévenance ; une dépréciation exige sa date", async () => {
    const v = await creerVersion("publiee");
    const autre = await creerVersion("publiee");
    expect(await codeErreur(enEquipe((c) => passage(c, v, "publiee", "depreciee")))).toBe("23514");
    await enEquipe((c) => passage(c, v, "publiee", "depreciee", ", fin_annoncee_le", ["2027-03-01"]));
    expect(await codeErreur(enEquipe((c) => passage(c, v, "depreciee", "retiree")))).toBe("23514");
    expect(await codeErreur(enEquipe((c) => passage(c, v, "depreciee", "retiree", ", remplacante_id, prevenance_le", [v.id, "2027-02-01"])))).toBe("23514");
    await enEquipe((c) => passage(c, v, "depreciee", "retiree", ", remplacante_id, prevenance_le", [autre.id, "2027-02-01"]));
  });

  it("[A-119] @isolation console_app, sous le client A puis sous le client B, ne lit ni n'écrit preuves_procedure ni passages_version", async () => {
    const v = await creerVersion();
    await enEquipe((c) => preuve(c, v, 1));
    for (const tenant of [randomUUID(), randomUUID()]) {
      for (const table of ["preuves_procedure", "passages_version"]) {
        expect(await codeErreur(avecClient(app, tenant, (c) => c.query(`SELECT 1 FROM ${table}`))), table).toBe("42501");
        expect(await codeErreur(avecClient(app, tenant, (c) => c.query(`INSERT INTO ${table} (version_id) VALUES ($1)`, [v.id]))), table).toBe("42501");
      }
    }
    const r = await migration.query("SELECT has_table_privilege('console_lecture', 'public.preuves_procedure', 'SELECT') AS l1, has_table_privilege('console_lecture', 'public.passages_version', 'SELECT') AS l2, has_table_privilege('public', 'public.passages_version', 'SELECT') AS p");
    expect(r.rows[0]).toEqual({ l1: false, l2: false, p: false });
    expect(await codeErreur(enEquipe(async (c) => { await c.query("SELECT set_config('app.tenant_id', $1, true)", [randomUUID()]); return preuve(c, v, 4); }))).not.toBe("ok");
  });

  it("[A-119] @isolation console_app voit les mêmes modeles_testes d'une version publiée sous A et sous B, et ne voit aucune version en recette", async () => {
    const publiee = await creerVersion("recette");
    await enEquipe((c) => c.query("UPDATE versions_automatisation SET modeles_testes = '{modele-a}' WHERE id = $1", [publiee.id]));
    const enRecette = publiee;
    const lire = (tenant: string, id: string) => avecClient(app, tenant, async (c) => (await c.query("SELECT modeles_testes FROM versions_automatisation WHERE id = $1", [id])).rows);
    expect(await lire(randomUUID(), enRecette.id)).toEqual([]);
    for (const s of ["pilote", "publiee"]) await enEquipe((c) => c.query("UPDATE versions_automatisation SET statut = $2 WHERE id = $1", [publiee.id, s]));
    const a = await lire(randomUUID(), publiee.id);
    const b = await lire(randomUUID(), publiee.id);
    expect(a).toEqual([{ modeles_testes: ["modele-a"] }]);
    expect(b).toEqual(a);
    expect(await codeErreur(avecClient(app, randomUUID(), (c) => c.query("UPDATE versions_automatisation SET modeles_testes = '{x}' WHERE id = $1", [publiee.id])))).toBe("42501");
  });

  it("[LOT4-cycle] @isolation 0027 s'applique sur une base qui a déjà des versions dans les six états (VALIDATE passe, modeles_testes reste nul)", async () => {
    // Le VALIDATE de 0027 a passé sur les lignes présentes (le rejeu avec des versions dans les six états avant 0027 est consigné dans spec/preuves/lot-4-t4-27a.md).
    const c = await migration.query("SELECT convalidated FROM pg_constraint WHERE conname = 'versions_automatisation_modeles_testes_bornes'");
    expect(c.rows).toEqual([{ convalidated: true }]);
    const v = await creerVersion();
    expect((await enEquipe((c) => c.query("SELECT modeles_testes FROM versions_automatisation WHERE id = $1", [v.id]))).rows).toEqual([{ modeles_testes: null }]);
  });
});
