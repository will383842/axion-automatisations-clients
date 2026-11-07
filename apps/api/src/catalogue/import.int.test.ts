import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { avecClient } from "../db/client-actif.js";
import { migrer } from "../db/migrer.js";
import { journalEchecs } from "../provisionnement/journal-echecs.js";
import { depotSql } from "./importer.js";
import { lireDemandePassage, lireDemandePreuve } from "./procedure.js";
import { creerCycle, depotSqlCycle } from "./preuves.js";

// Dépôt PostgreSQL de l'import (T4-25), sur le socle lancé par ops/socle/lancer.sh (job socle-integration). Pas de Docker en routine : écrit pour la CI.
// Les échecs sont journalisés sans secret (writeSync sur la sortie d'erreur).
// Toute écriture de l'équipe passe par le déclencheur d'audit, qui attend le verrou du journal : audit.int.test.ts (même fragment) le tient près de 7 s dans son essai [C-028]. 5 s ne suffisent pas en CI.
vi.setConfig({ testTimeout: 30_000 });
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = (service: string) => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", `label=com.docker.compose.service=${service}`);
function cible(service: string, port: number, surcharge: string | undefined) {
  if (surcharge) return { host: surcharge.split(":")[0] ?? "", port: Number(surcharge.split(":")[1]) };
  return { host: docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur(service)), port };
}
function secret(): string {
  if (process.env["SOCLE_PG_MOT_DE_PASSE"]) return process.env["SOCLE_PG_MOT_DE_PASSE"];
  const ligne = docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", conteneur("postgres")).split("\n").find((l) => l.startsWith("SOCLE_PG_MOT_DE_PASSE="));
  if (!ligne) throw new Error("mot de passe de test introuvable");
  return ligne.slice("SOCLE_PG_MOT_DE_PASSE=".length);
}
const equipe = new pg.Pool({ ...cible("pgbouncer", 6432, process.env["SOCLE_PG_PGBOUNCER"]), user: "console_equipe", database: "console", password: createHash("sha256").update(`${secret()}/console_equipe`).digest("hex"), max: 2, connectionTimeoutMillis: 10_000 });
equipe.on("error", () => undefined);
afterAll(() => equipe.end());

const lettres = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
const depot = depotSql(async (fn) => {
  const c = await equipe.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.acteur', 'equipe-import-essai', true), set_config('lock_timeout', '5s', true)");
    const r = await fn(async (texte, valeurs) => (await c.query(texte, valeurs)).rows as Record<string, unknown>[]);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    writeSync(2, `import.int : échec ${(e as { code?: string }).code ?? "inconnu"}\n`);
    throw e;
  } finally {
    c.release();
  }
});
const entree = (code: string, semver: string, empreinte: string) => ({
  codeAutomatisation: code,
  nomAutomatisation: "module-essai",
  semver,
  apiMoteur: "^0.1.0",
  empreinte,
  ref: `modules/${empreinte}/`,
  signature: "c2lnbmF0dXJlLWZpY3RpdmU=",
  schemaConfiguration: { type: "object", properties: { actionsAutomatiquesAutorisees: {} } },
  manifeste: { connecteurs: [{ famille: "messagerie" }], idCle: "cle-essai-1" },
});

describe("dépôt SQL de l'import", () => {
  it("[A-024] une version importée naît brouillon, l'automatisation nouvelle est créée", async () => {
    const code = `${lettres(5)}-123`;
    const r = await depot.enregistrer(entree(code, "1.0.0", hex()));
    expect(r.cree).toBe(true);
    expect(r.version.statut).toBe("brouillon");
    const ligne = (await equipe.query("SELECT v.statut, v.nature FROM versions_automatisation v JOIN automatisations a ON a.id = v.automatisation_id WHERE a.code = $1", [code])).rows[0];
    expect(ligne).toEqual({ statut: "brouillon", nature: "creation" });
  });

  it("[A-407] deux imports simultanés de la même version avec deux empreintes : une seule ligne, l'autre voit la version en place", async () => {
    const code = `${lettres(5)}-456`;
    const [a, b] = [hex(), hex()];
    const [ra, rb] = await Promise.all([depot.enregistrer(entree(code, "1.0.0", a)), depot.enregistrer(entree(code, "1.0.0", b))]);
    expect([ra.cree, rb.cree].filter(Boolean)).toHaveLength(1);
    expect(ra.version.empreinte).toBe(rb.version.empreinte);
    expect((await equipe.query("SELECT count(*)::int AS n FROM versions_automatisation v JOIN automatisations x ON x.id = v.automatisation_id WHERE x.code = $1", [code])).rows[0]?.["n"]).toBe(1);
  });

  it("[A-407] la même empreinte sous un autre numéro de version n'est pas enregistrée de nouveau", async () => {
    const code = `${lettres(5)}-789`;
    const e = hex();
    await depot.enregistrer(entree(code, "1.0.0", e));
    const r = await depot.enregistrer(entree(code, "1.1.0", e));
    expect(r.cree).toBe(false);
    expect(r.version.semver).toBe("1.0.0");
  });

  it("[C-248] un nom de module différent sous un code d'automatisation existant est refusé et n'ajoute aucune version", async () => {
    const code = `${lettres(5)}-321`;
    await depot.enregistrer(entree(code, "1.0.0", hex()));
    await expect(depot.enregistrer({ ...entree(code, "2.0.0", hex()), nomAutomatisation: "module-autre" })).rejects.toMatchObject({ code: "identifiant_deja_pris" });
    expect((await equipe.query("SELECT count(*)::int AS n FROM versions_automatisation v JOIN automatisations x ON x.id = v.automatisation_id WHERE x.code = $1", [code])).rows[0]?.["n"]).toBe(1);
  });
});

// ---- Cycle de vie des versions (T4-27a, migration 0027, ADR 0122) -------------------------------------------------------------------------------------
// Ces essais vivent ici et non dans un fichier neuf : un nouveau *.int.test.ts prend le poids par défaut et déplace la partition des fragments du socle (ADR 0121),
// ce qui réunit migrer.int et moteur.int dans un même fragment où le second voit la base jetable du premier. Dette : les sortir dans leur fichier après la révision des poids.
journalEchecs(import.meta.url);
const SECRET = secret();
const DIRECT = cible("postgres", 5432, process.env["SOCLE_PG_DIRECT"]);
const motDePasseDe = (role: string) => createHash("sha256").update(`${SECRET}/${role}`).digest("hex");
const poolDe = (user: string, max: number) => {
  const p = new pg.Pool({ ...DIRECT, user, database: "console", password: motDePasseDe(user), max, connectionTimeoutMillis: 10_000 });
  p.on("error", () => undefined);
  return p;
};
const migration = poolDe("console_migration", 2);
const app = poolDe("console_app", 4);

const ACTEUR = "equipe-cycle-essai";

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
// Le verrou du journal d'audit peut être tenu ~7 s par audit.int.test.ts (même fragment) : le lock_timeout du rôle (5 s) annule alors la transaction (55P03). Rien n'a été écrit, on la rejoue.
async function enEquipe<T>(fn: (c: pg.PoolClient) => Promise<T>, acteur = ACTEUR): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await enEquipeUneFois(fn, acteur);
    } catch (e) {
      if ((e as { code?: string }).code !== "55P03" || essai >= 4) throw e;
    }
  }
}
async function enEquipeUneFois<T>(fn: (c: pg.PoolClient) => Promise<T>, acteur: string): Promise<T> {
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
  await Promise.all([migration.end(), app.end()]);
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

// Dépôt SQL du cycle de vie (T4-27b), sur la même base : un seul fichier d'essai pour rester dans le même fragment du socle (ADR 0121).
describe("cycle de vie des versions : dépôt SQL (T4-27b)", () => {
  const depotCycle = depotSqlCycle((acteur, fn) => enEquipe((c) => fn(async (texte, valeurs) => (await c.query(texte, valeurs)).rows as Record<string, unknown>[]), acteur));
  const cycle = (definitives = 0) => creerCycle({ depot: depotCycle, erreursPilote: { compterDefinitives: async () => definitives }, journal: { ecrire: async () => undefined }, interrupteurs: { etape6Exigee: false } });
  const rapport = { module: "module-essai", version: "1.0.0", cas: [{ id: "cas-1", categorie: "nominal", reussi: true }], determinisme: [{ etape: "relecture", reussi: true }], hostile: { demandes: { refusees: 1, brouillons: 0, automatiques: 0 }, appelsConnecteur: 0, violations: 0 }, totaux: { reussis: 2, echoues: 0 }, codeSortie: 0, modeles: ["modele-essai-1"] };
  const refuse = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { return (e as Error).message; } };
  async function versionComplete() {
    const v = await creerVersion();
    await enEquipe((c) => c.query("UPDATE versions_automatisation SET schema_configuration = '{\"type\":\"object\"}'::jsonb WHERE id = $1", [v.id]));
    return v;
  }
  const prouver = (v: { id: string; empreinte: string }, corps: Record<string, unknown>) => cycle().deposer(v.id, lireDemandePreuve({ empreinte_sha256: v.empreinte, ...corps }), ACTEUR);
  const passer = (v: { id: string; empreinte: string }, depart: string, vers: string, extra: Record<string, unknown> = {}, cy = cycle()) => cy.passer(v.id, lireDemandePassage({ depart, vers, empreinte_sha256: v.empreinte, ...extra }), ACTEUR);
  const fiche = { benefice: "Gain de temps", prerequis: "Messagerie reliée", temps_gagne: "Dix minutes", prix: "[montant]" };
  async function jusquEnRecette(v: { id: string; empreinte: string }) {
    await prouver(v, { etape: 1, cadrage: { probleme: "Relances oubliées", declencheur: "Devis sans réponse", minutes_par_element: 6, donnees_personnelles: { presentes: false, categories: [] } } });
    for (const [etape, reference] of [[2, "prototype-essai"], [3, "schema-essai"], [5, "controle-essai"], [8, "signature-recette-essai"]] as const) await prouver(v, { etape, reference });
    await passer(v, "brouillon", "recette");
  }
  // Seule façon de reculer l'heure d'un passage : le propriétaire, RLS le temps de l'opération (jamais le rôle de l'équipe).
  const antidater = (id: string, jours: number) => enProprietaire(async (c) => {
    await c.query("SELECT set_config('app.acteur', $1, true)", [ACTEUR]);
    await c.query("ALTER TABLE passages_version NO FORCE ROW LEVEL SECURITY");
    await c.query("ALTER TABLE preuves_procedure NO FORCE ROW LEVEL SECURITY");
    await c.query("UPDATE passages_version SET passe_le = passe_le - make_interval(days => $2) WHERE version_id = $1", [id, jours]);
    await c.query("UPDATE preuves_procedure SET cree_le = cree_le - make_interval(days => $2) WHERE version_id = $1", [id, jours]);
    await c.query("ALTER TABLE passages_version FORCE ROW LEVEL SECURITY");
    await c.query("ALTER TABLE preuves_procedure FORCE ROW LEVEL SECURITY");
  });

  it("[A-305] @isolation la chaîne brouillon → recette → pilote → publiee passe par la machine du serveur, sur la base", async () => {
    const v = await versionComplete();
    expect(await refuse(passer(v, "brouillon", "recette"))).toMatch(/Étapes manquantes : 1, 2, 3, 5, 8/);
    await jusquEnRecette(v);
    await prouver(v, { etape: 4, rapport });
    await prouver(v, { etape: 7, mesure_ms: 900, notes_de_version: "Première version", fiche });
    expect((await enEquipe((c) => c.query("SELECT modeles_testes FROM versions_automatisation WHERE id = $1", [v.id]))).rows).toEqual([{ modeles_testes: ["modele-essai-1"] }]);
    await passer(v, "recette", "pilote");
    const publier = () => passer(v, "pilote", "publiee", { signature_production: "signature-prod-essai" });
    expect(await refuse(publier())).toMatch(/Étapes manquantes : 9/);
    await antidater(v.id, 8);
    await publier();
    const lignes = await enEquipe((c) => c.query("SELECT statut_depart || '>' || statut_arrivee AS p FROM passages_version WHERE version_id = $1 ORDER BY passe_le, statut_arrivee", [v.id]));
    expect(lignes.rows.map((r) => r["p"]).sort()).toEqual(["brouillon>recette", "pilote>publiee", "recette>pilote"]);
    const dix = await enEquipe((c) => c.query("SELECT reference, contenu FROM preuves_procedure WHERE version_id = $1 AND etape = 10", [v.id]));
    expect(dix.rows).toEqual([{ reference: "signature-prod-essai", contenu: { rapport_mensuel: true } }]);
    expect((await enEquipe((c) => c.query("SELECT statut FROM versions_automatisation WHERE id = $1", [v.id]))).rows).toEqual([{ statut: "publiee" }]);
  });

  it("[C-249] @isolation le délai de 7 jours est calculé en SQL sur la dernière ligne recette → pilote de la bonne empreinte", async () => {
    const v = await versionComplete();
    await jusquEnRecette(v);
    await prouver(v, { etape: 4, rapport });
    await prouver(v, { etape: 7, mesure_ms: 900, notes_de_version: "Première version", fiche });
    await passer(v, "recette", "pilote");
    const delai = (empreinte = v.empreinte) => depotCycle.transaction(ACTEUR, (tx) => tx.delaiPilote(v.id, empreinte));
    expect((await delai())?.ecoule).toBe(false);
    await antidater(v.id, 8);
    expect((await delai())?.ecoule).toBe(true);
    // Une ligne d'une autre empreinte ne compte pas ; une ligne plus récente de la bonne empreinte fait repartir le délai (dernière ligne).
    expect(await delai(hex())).toBeUndefined();
    await enEquipe((c) => passage(c, v, "recette", "pilote"));
    expect((await delai())?.ecoule).toBe(false);
  });

  it("[C-240] @isolation deux passages simultanés d'une même version : un seul réussit (SELECT … FOR UPDATE)", async () => {
    const v = await versionComplete();
    for (const [etape, reference] of [[2, "prototype-essai"], [3, "schema-essai"], [5, "controle-essai"], [8, "signature-recette-essai"]] as const) await prouver(v, { etape, reference });
    await prouver(v, { etape: 1, cadrage: { probleme: "Relances oubliées", declencheur: "Devis sans réponse", minutes_par_element: 6, donnees_personnelles: { presentes: false, categories: [] } } });
    const r = await Promise.allSettled([passer(v, "brouillon", "recette"), passer(v, "brouillon", "recette")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await enEquipe((c) => c.query("SELECT count(*)::int AS n FROM passages_version WHERE version_id = $1", [v.id]))).rows).toEqual([{ n: 1 }]);
  });

  it("[C-240] @isolation une preuve rangée après le passage qu'elle devait permettre ne compte pas, et une autre empreinte non plus", async () => {
    const v = await versionComplete();
    await jusquEnRecette(v);
    await prouver(v, { etape: 4, rapport });
    const compte = (borne: "recette" | null, empreinte = v.empreinte) => depotCycle.transaction(ACTEUR, (tx) => tx.etapesProuvees(v.id, empreinte, borne));
    expect((await compte("recette")).sort()).toEqual([1, 2, 3, 5, 8]);
    expect((await compte(null)).sort()).toEqual([1, 2, 3, 4, 5, 8]);
    expect(await compte(null, hex())).toEqual([]);
  });

  it("[B-462] @isolation un retrait vers une remplaçante d'une autre automatisation ou non publiée est refusé, sur la base", async () => {
    const v = await creerVersion("publiee");
    const autre = await creerVersion("publiee");
    await passer(v, "publiee", "depreciee", { fin_annoncee_le: "2027-03-01" });
    expect(await refuse(passer(v, "depreciee", "retiree", { remplacante_id: autre.id, prevenance_le: "2026-01-02" }))).toMatch(/même automatisation/);
    const meme = await enEquipe(async (c) => {
      const a = (await c.query("SELECT automatisation_id FROM versions_automatisation WHERE id = $1", [v.id])).rows[0]?.["automatisation_id"] as string;
      const e = hex();
      return { id: (await c.query("INSERT INTO versions_automatisation (automatisation_id, semver, api_moteur, artefact_ref, empreinte_sha256, signature_ed25519, sbom_ref) VALUES ($1, '1.1.0', '^0.1.0', $2, $3, 'c2lnbmF0dXJlLWZpY3RpdmU=', 'sbom/essai') RETURNING id", [a, `modules/${e}/`, e])).rows[0]?.["id"] as string, empreinte: e };
    });
    expect(await refuse(passer(v, "depreciee", "retiree", { remplacante_id: meme.id, prevenance_le: "2026-01-02" }))).toMatch(/publiée/);
    expect(await refuse(passer(v, "depreciee", "retiree", { remplacante_id: meme.id, prevenance_le: "2099-01-02" }))).toMatch(/publiée|prévenance/);
    for (const s of ["recette", "pilote", "publiee"]) await enEquipe((c) => c.query("UPDATE versions_automatisation SET statut = $2 WHERE id = $1", [meme.id, s]));
    expect(await refuse(passer(v, "depreciee", "retiree", { remplacante_id: meme.id, prevenance_le: "2099-01-02" }))).toMatch(/prévenance/);
    await passer(v, "depreciee", "retiree", { remplacante_id: meme.id, prevenance_le: "2026-01-02" });
    expect((await enEquipe((c) => c.query("SELECT statut FROM versions_automatisation WHERE id = $1", [v.id]))).rows).toEqual([{ statut: "retiree" }]);
  });
});
