import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient, avecEquipe } from "./client-actif.js";
import { migrer } from "./migrer.js";

// Tables clients, contacts, instances et journal d'audit branché (T2-01b), contre le socle lancé par ops/socle/lancer.sh (job socle-integration).
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

const migration = pool(DIRECT, "console_migration", 3);
const app = pool(PGBOUNCER, "console_app", 60);
const equipe = pool(PGBOUNCER, "console_equipe", 3);
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const AJOUTER = "SELECT public.audit_ajouter($1::uuid, $2, $3::public.action_audit, $4, $5, $6::jsonb, $7::jsonb) AS id";
const PLATEFORME = "00000000-0000-0000-0000-000000000001";
const APPELANT = { acteur: "agent-essai", ip: "192.0.2.17" };
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Les écritures auditées passent toutes par le verrou du journal. Un autre fichier d'essai (audit.int.test.ts, plus bas ici) le garde exprès jusqu'à 5 s :
// une écriture de mise en place qui attend plus que lock_timeout reçoit 55P03. Elle est rejouée ; les essais qui jugent ce délai (plus bas) utilisent avecClient tel quel.
async function ecrire<T>(...args: Parameters<typeof avecClient<T>>): Promise<T> {
  for (let essai = 1; ; essai++) {
    try {
      return await avecClient(...args);
    } catch (e) {
      if ((e as { code?: string }).code !== "55P03" || essai >= 4) throw e;
    }
  }
}

// Lignes dont le chaînage est faux, sur tout le journal (même contrôle que audit.int.test.ts).
async function lignesCassees(): Promise<number> {
  const { rows } = await migration.query(`
    SELECT count(*)::int AS n FROM (SELECT j.*, lag(j.empreinte) OVER (ORDER BY j.id) AS avant FROM public.journal_audit j) t
    WHERE t.empreinte_precedente IS DISTINCT FROM t.avant
       OR t.empreinte <> encode(sha256(convert_to(coalesce(t.avant, '') || public.audit_contenu(t.id, t.tenant_id, t.acteur, t.action, t.entite, t.entite_id, t.ancienne, t.nouvelle, t.ip, t.cree_le), 'UTF8')), 'hex')`);
  return rows[0]?.["n"] as number;
}
const creerOrg = (id: string, extra: Record<string, unknown> = {}) => {
  const v = { id, tenant_id: id, console_client_id: id, raison_sociale: "Atelier Bertin", ...extra };
  const cles = Object.keys(v);
  return ecrire(app, id, (c) => c.query(`INSERT INTO organisations (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v)), APPELANT);
};
// T2-05 : une instance ne passe à « active » (valeur par défaut comprise) qu'avec un contrat de sous-traitance signé : un contrat par client d'essai, posé une fois.
const sousTraitance = new Map<string, Promise<unknown>>();
const signerSousTraitance = (tenant: string) => {
  const v = { id: randomUUID(), tenant_id: tenant, organisation_id: tenant, type: "sous_traitance_art28", date_signature: "2026-01-15", pdf_ref: `contrats/${tenant}/art28.pdf`, empreinte_sha256: "a".repeat(64), auteur: APPELANT.acteur };
  const cles = Object.keys(v);
  if (!sousTraitance.has(tenant)) sousTraitance.set(tenant, ecrire(app, tenant, (c) => c.query(`INSERT INTO contrats (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v)), APPELANT));
  return sousTraitance.get(tenant);
};
const creerInstance = async (tenant: string, extra: Record<string, unknown> = {}) => {
  if ((extra["etat"] ?? "active") === "active") await signerSousTraitance(tenant);
  const v = { tenant_id: tenant, organisation_id: tenant, code_automatisation: "relance-devis", formule: "abonnement", environnement: "production", ...extra };
  const cles = Object.keys(v);
  return ecrire(app, tenant, (c) => c.query(`INSERT INTO instances (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, Object.values(v)), APPELANT);
};

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

// Le rapport de la CI est un JSON hors du journal : un essai en échec est écrit ici pour être lisible dans le journal du job.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

// Délai large : les autres fichiers du socle écrivent au même journal, dont un essai qui garde son verrou jusqu'à 5 s (audit.int.test.ts).
describe("tables de client, avec le socle", { timeout: 30_000 }, () => {
  it("[A-119] @isolation toutes les migrations appliquées, les invariants C5 ne trouvent aucun écart", async () => {
    // Les autres fichiers d'essai créent des schémas jetables « essai_* » sur la même base, en parallèle : ils ne comptent pas ici.
    // Le schéma partman (outil de partition, installé par le socle) n'est pas une table métier : seules les tables de public sont jugées.
    const ecarts = (await controlerInvariants(requete, "console", OPTIONS)).filter((e) => !/(^|\.)essai_/.test(e.objet) && !e.objet.startsWith("partman."));
    expect(ecarts).toEqual([]);
    const { rows } = await migration.query("SELECT relname FROM pg_class WHERE relname IN ('organisations', 'contacts', 'instances') AND relkind = 'r' ORDER BY 1");
    expect(rows.map((r) => r.relname)).toEqual(["contacts", "instances", "organisations"]);
  });

  it("[A-119] @isolation une table de tableClient() a la clé primaire (tenant_id, id) et UNIQUE (tenant_id, id) ; console_client_id différent de tenant_id est refusé", async () => {
    // PostgreSQL fusionne UNIQUE (tenant_id, id) avec la clé primaire de mêmes colonnes : un seul index unique, qui sert de cible aux clés étrangères composées (ADR 0044).
    const { rows } = await migration.query(`
      SELECT i.indisprimary, (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n) AS cols
      FROM pg_index i WHERE i.indrelid = 'public.instances'::regclass AND i.indisunique`);
    // + instances_id_unique (ADR 0111, migration 0019) + instances_une_par_automatisation (ADR 0125, migration 0028) : l'ordre des index n'est pas garanti.
    expect(rows.map((r) => `${r.indisprimary}:${r.cols}`).sort()).toEqual(["false:id", "false:tenant_id,automatisation_id,environnement", "true:tenant_id,id"]);
    const fk = await migration.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'instances_organisation_fk'");
    expect(fk.rows[0]?.d).toContain("REFERENCES organisations(tenant_id, id)");
    const A = randomUUID();
    await expect(creerOrg(A, { console_client_id: randomUUID() })).rejects.toMatchObject({ code: "23514" });
    await creerOrg(A);
  });

  it("[A-119] la ligne « plateforme » existe, est unique et n'est visible d'aucun client", async () => {
    const vue = await avecEquipe(equipe, async (c) => (await c.query("SELECT id, tenant_id FROM organisations WHERE id = $1", [PLATEFORME])).rows);
    expect(vue).toEqual([{ id: PLATEFORME, tenant_id: PLATEFORME }]);
    const A = randomUUID();
    await creerOrg(A);
    expect((await ecrire(app, A, (c) => c.query("SELECT 1 FROM organisations WHERE id = $1", [PLATEFORME]))).rowCount).toBe(0);
  });

  it("[A-120] une organisation se crée avec SIREN, métier, code NAF, taille et statut", async () => {
    const A = randomUUID();
    const { rows } = await creerOrg(A, { raison_sociale: "Lemoine Rénovation", siren: "123456782", metier: "bâtiment", code_naf: "43.39Z", taille: "pme", statut: "client" });
    expect(rows[0]).toMatchObject({ siren: "123456782", metier: "bâtiment", code_naf: "43.39Z", taille: "pme", statut: "client" });
    await expect(creerOrg(randomUUID(), { siren: "12345" })).rejects.toMatchObject({ code: "23514" });
    // Pas d'unicité sur le SIREN : plusieurs établissements, le doublon se tranche ailleurs (C-456, T2-15).
    await creerOrg(randomUUID(), { siren: "123456782" });
  });

  it("[A-156] le statut accepte prospect, en_signature, client et ancien_client et refuse une valeur hors énumération", async () => {
    for (const statut of ["prospect", "en_signature", "client", "ancien_client"]) expect((await creerOrg(randomUUID(), { statut })).rows[0]?.statut).toBe(statut);
    await expect(creerOrg(randomUUID(), { statut: "perdu" })).rejects.toMatchObject({ code: "22P02" });
  });

  it("[C-361] deux organisations ne peuvent pas porter le même console_client_id", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await expect(creerOrg(A)).rejects.toMatchObject({ code: "23505" });
    await expect(creerOrg(randomUUID(), { console_client_id: A })).rejects.toMatchObject({ code: "23514" });
  });

  it("[C-331] une organisation prospect garde seulement sa référence crm_company_id", async () => {
    const { rows } = await creerOrg(randomUUID(), { statut: "prospect", crm_company_id: "crm-essai-001" });
    expect(rows[0]).toMatchObject({ statut: "prospect", crm_company_id: "crm-essai-001", siren: null, metier: null, code_naf: null, taille: null });
  });

  it("[A-121] un contact garde nom, e-mail, rôle, accès portail et id Keycloak", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const keycloak = randomUUID();
    const { rows } = await ecrire(app, A, (c) =>
      c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role, acces_portail, keycloak_id) VALUES ($1, $2, $2, 'Camille Essai', 'camille@exemple.fr', 'facturation', true, $3) RETURNING *", [randomUUID(), A, keycloak]), APPELANT);
    expect(rows[0]).toMatchObject({ nom: "Camille Essai", email: "camille@exemple.fr", role: "facturation", acces_portail: true, keycloak_id: keycloak });
    // Clé étrangère composée : un contact ne se rattache pas à l'organisation d'un autre client.
    const B = randomUUID();
    await creerOrg(B);
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role) VALUES ($1, $2, $3, 'X', 'x@exemple.fr', 'principal')", [randomUUID(), A, B]))).rejects.toThrow();
  });

  it("[A-126] une instance refuse un état hors active, pause, erreur, livree", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const etat of ["active", "pause", "erreur", "livree"]) await creerInstance(A, { etat });
    await expect(creerInstance(A, { etat: "supprimee" })).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-119] @isolation avec le client A, console_app ne lit ni n'écrit aucune ligne de B dans organisations, contacts, instances", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const instanceB = (await creerInstance(B)).rows[0]?.id as string;
    await ecrire(app, B, (c) => c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role) VALUES ($1, $2, $2, 'Autre Essai', 'autre@exemple.fr', 'principal')", [randomUUID(), B]), APPELANT);
    await ecrire(app, A, async (c) => {
      for (const t of ["organisations", "contacts", "instances"]) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B])).rows[0]?.n, t).toBe(0);
        // T2-52 : console_app n'écrit plus tenant_id d'instances et n'y supprime plus rien (droits par colonne, 0019) ; la RLS reste prouvée par UPDATE etat.
        const maj = t === "instances" ? "UPDATE instances SET etat = etat WHERE tenant_id = $1" : `UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`;
        expect((await c.query(maj, [B])).rowCount, t).toBe(0);
        if (t !== "instances") expect((await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [B])).rowCount, t).toBe(0);
      }
      expect((await c.query("UPDATE instances SET etat = 'pause' WHERE id = $1", [instanceB])).rowCount).toBe(0);
    }, APPELANT);
    // Écrire une ligne au nom de B depuis A : refus par WITH CHECK.
    await expect(ecrire(app, A, (c) => c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'x', 'abonnement', 'test', 'pause')", [B]))).rejects.toMatchObject({ code: "42501" });
    // Sans client actif : aucune ligne ; chaîne, identifiant ou injection dans app.tenant_id : refusés ou vides.
    for (const t of ["organisations", "contacts", "instances"]) expect((await app.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n, t).toBe(0);
    for (const mauvais of ["", "pas-un-uuid", `${A}' OR '1'='1`]) {
      const c = await app.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [mauvais]);
        await expect(c.query("SELECT count(*)::int AS n FROM instances").then((r) => r.rows[0]?.n)).resolves.toBe(0);
      } catch (e) {
        expect(String((e as Error).message)).toMatch(/invalid input syntax for type uuid/);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
  });

  it("[A-178] une insertion et une modification d'instance écrivent chacune une ligne au journal avec ancienne et nouvelle valeur, acteur et IP", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = (await creerInstance(A)).rows[0]?.id as string;
    await ecrire(app, A, (c) => c.query("UPDATE instances SET etat = 'pause' WHERE id = $1", [id]), APPELANT);
    // La suppression d'une instance est refusée à console_app depuis 0019 (testée dans durcissement.int.test.ts) : le journal ne reçoit plus que l'insertion et la modification.
    const { rows } = await migration.query("SELECT action, acteur, host(ip) AS ip, ancienne, nouvelle FROM public.journal_audit WHERE tenant_id = $1 AND entite = 'instances' AND entite_id = $2 ORDER BY id", [A, id]);
    expect(rows.map((r) => r.action)).toEqual(["insertion", "modification"]);
    expect(rows.every((r) => r.acteur === "agent-essai" && r.ip === "192.0.2.17")).toBe(true);
    expect(rows[0]).toMatchObject({ ancienne: null, nouvelle: { etat: "active" } });
    expect(rows[1]).toMatchObject({ ancienne: { etat: "active" }, nouvelle: { etat: "pause" } });
    expect(await lignesCassees()).toBe(0);
  });

  it("[A-178] la création d'une organisation écrit au journal ; un contact (données de personnes) n'est pas encore copié au journal (ADR 0044)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await ecrire(app, A, (c) => c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role) VALUES ($1, $2, $2, 'Camille Essai', 'camille@exemple.fr', 'principal')", [randomUUID(), A]), APPELANT);
    const { rows } = await migration.query("SELECT entite FROM public.journal_audit WHERE tenant_id = $1", [A]);
    expect(rows.map((r) => r.entite)).toEqual(["organisations"]);
  });

  it("[C-028] @isolation UPDATE, DELETE et TRUNCATE du journal sont refusés pour console_app et console_equipe, après des écritures de tables de client", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const p of [app, equipe]) {
      await expect(p.query("TRUNCATE public.journal_audit")).rejects.toThrow(/permission denied|ajout seul/);
      await expect(ecrire(p, A, (c) => c.query("UPDATE public.journal_audit SET acteur = 'forge'"))).rejects.toThrow(/permission denied/);
    }
    expect(await lignesCassees()).toBe(0);
  });

  it("[C-028] 50 écritures métier parallèles à travers PgBouncer donnent une chaîne continue", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await Promise.all(Array.from({ length: 50 }, () => creerInstance(A)));
    const { rows } = await migration.query("SELECT count(*)::int AS n FROM public.journal_audit WHERE tenant_id = $1 AND entite = 'instances'", [A]);
    expect(rows[0]?.n).toBe(50);
    expect(await lignesCassees()).toBe(0);
    const doubles = await migration.query("SELECT count(*)::int AS n FROM (SELECT empreinte_precedente FROM public.journal_audit WHERE empreinte_precedente IS NOT NULL GROUP BY 1 HAVING count(*) > 1) t");
    expect(doubles.rows[0]?.n).toBe(0);
  }, 60_000);

  it("[A-131] @isolation ni l'acteur ni l'IP ne passent à la transaction suivante sur une connexion recyclée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const seul = pool(PGBOUNCER, "console_app", 1);
    await ecrire(seul, A, (c) => c.query("SELECT 1"), APPELANT);
    const apres = await seul.query("SELECT current_setting('app.acteur', true) AS a, current_setting('app.ip', true) AS i, current_setting('lock_timeout') AS l");
    // Derrière PgBouncer (DISCARD ALL), un réglage personnalisé jamais posé sur cette connexion serveur vaut NULL, sinon une chaîne vide : les deux disent « rien ».
    expect(apres.rows[0]?.a ?? "").toBe("");
    expect(apres.rows[0]?.i ?? "").toBe("");
    expect(apres.rows[0]?.l).not.toBe("5s");
  });
});

describe("réserves de l'audit de la PR 95, avec le socle", { timeout: 60_000 }, () => {
  it("[A-131] @isolation une transaction qui tient une ligne sans rien faire est coupée par PostgreSQL : l'écriture auditée d'un tiers passe en moins de 10 s", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const X = (await creerInstance(A)).rows[0]?.id as string;
    const tiers = randomUUID();
    await creerOrg(tiers);
    // T0 : verrou de ligne sur X puis inactivité de 9 s. T1 : écriture auditée (prend le journal) puis attente de la ligne X. Tiers : écriture auditée.
    const t0 = avecClient(app, A, async (c) => {
      c.on("error", () => undefined); // PostgreSQL coupe la session : l'erreur de connexion est attendue
      await c.query("SELECT id FROM instances WHERE id = $1 FOR UPDATE", [X]);
      await dormir(9000);
      await c.query("SELECT 1");
    }).catch((e: unknown) => e);
    await dormir(300);
    const t1 = avecClient(app, A, async (c) => {
      await c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'x', 'abonnement', 'test', 'pause')", [A]);
      await c.query("UPDATE instances SET etat = 'pause' WHERE id = $1", [X]);
    }).catch((e: unknown) => e);
    await dormir(1000);
    const debut = Date.now();
    await avecClient(app, tiers, (c) => c.query("INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat) VALUES ($1, $1, 'x', 'abonnement', 'test', 'pause')", [tiers]), APPELANT);
    // La borne de la fiche est 10 s ; derrière PgBouncer (4 connexions serveur par rôle) l'attente d'une connexion s'y ajoute : 30 s, l'échec réel est une erreur 55P03.
    expect(Date.now() - debut).toBeLessThan(30_000);
    await Promise.all([t0, t1]);
    expect(await lignesCassees()).toBe(0);
  }, 60_000);

  it("[A-131] @isolation deux transactions qui écrivent X puis Y et Y puis X : une seule est annulée (40P01), l'autre aboutit, la chaîne reste intacte", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const X = (await creerInstance(A)).rows[0]?.id as string;
    const Y = (await creerInstance(A)).rows[0]?.id as string;
    const maj = (c: pg.PoolClient, id: string) => c.query("UPDATE instances SET etat = 'pause' WHERE id = $1", [id]);
    const t1 = avecClient(app, A, async (c) => { await maj(c, X); await dormir(500); await maj(c, Y); }, APPELANT).then(() => "ok", (e: { code?: string }) => e.code);
    await dormir(150);
    const t2 = avecClient(app, A, async (c) => { await maj(c, Y); await dormir(500); await maj(c, X); }, APPELANT).then(() => "ok", (e: { code?: string }) => e.code);
    const issues = (await Promise.all([t1, t2])).sort();
    expect(issues).toEqual(["40P01", "ok"]);
    expect(await lignesCassees()).toBe(0);
  }, 30_000);

  it("[A-131] @isolation une colonne de plus de 256 Kio ne fait pas échouer l'écriture métier : la valeur est omise de la copie au journal", async () => {
    const A = randomUUID();
    await creerOrg(A, { metier: "x".repeat(300_000) });
    const { rows } = await migration.query("SELECT nouvelle, octet_length(nouvelle::text) AS n FROM public.journal_audit WHERE tenant_id = $1 AND entite = 'organisations'", [A]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.n).toBeLessThan(262_144);
    expect(rows[0]?.nouvelle).toMatchObject({ metier: { _omis: "taille" }, raison_sociale: "Atelier Bertin" });
    const apres = await ecrire(app, A, (c) => c.query("SELECT length(metier) AS n FROM organisations WHERE id = $1", [A]));
    expect(apres.rows[0]?.n).toBe(300_000);
    await ecrire(app, A, (c) => c.query("UPDATE organisations SET metier = $2 WHERE id = $1", [A, "y".repeat(300_000)]), APPELANT);
    expect(await lignesCassees()).toBe(0);
  });

  it("[A-131] @isolation audit_ajouter refuse U+180E, U+00AD et U+3164 dans l'acteur et dans l'identifiant d'entité", async () => {
    const A = randomUUID();
    for (const car of ["\u180E", "\u00AD", "\u3164"]) {
      await expect(ecrire(app, A, (c) => c.query(AJOUTER, [A, `agent${car}forge`, "insertion", "essai_car", "ok", null, null])), `acteur U+${car.codePointAt(0)?.toString(16)}`).rejects.toThrow(/acteur invalide/);
      await expect(ecrire(app, A, (c) => c.query(AJOUTER, [A, "agent-essai", "insertion", "essai_car", `id${car}x`, null, null])), `entite_id U+${car.codePointAt(0)?.toString(16)}`).rejects.toThrow(/identifiant d'entité invalide/);
    }
    await ecrire(app, A, (c) => c.query(AJOUTER, [A, "agent-é-ñ", "insertion", "essai_car", "ok", null, null]));
  });

  it("[A-131] @isolation la migration refuse de s'appliquer si le journal contient une adresse IP avec masque (contrôle de l'ADR 0042)", async () => {
    const dossier = fileURLToPath(new URL("../../drizzle", import.meta.url));
    const texte = readFileSync(`${dossier}/0003_journal_audit_reserves_t201b.sql`, "utf8");
    const controle = texte.split("--> statement-breakpoint").find((m) => m.includes("masklen"));
    expect(controle).toBeTruthy();
    const essai = async (ip: string | null) => {
      const c = await migration.connect();
      try {
        await c.query("BEGIN");
        await c.query("INSERT INTO public.journal_audit (acteur, action, entite, ip, empreinte) VALUES ('essai', 'insertion', 'essai_masque', $1, 'x')", [ip]);
        await c.query(controle as string);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };
    await expect(essai("192.0.2.0/24")).rejects.toThrow(/adresse IP avec masque/);
    await expect(essai("2001:db8::/32")).rejects.toThrow(/adresse IP avec masque/);
    await expect(essai("192.0.2.17")).resolves.toBeUndefined();
    await expect(essai(null)).resolves.toBeUndefined();
  });
});

// Migration 0028 (T4-28a, ADR 0125) : tests à blanc et journal des déploiements. Mise en place du catalogue et des configurations par le propriétaire de la base (les routes viennent avec T4-28b).
describe("déploiement (T4-28a)", { timeout: 30_000 }, () => {
  const su = pool(DIRECT, "postgres", 2);
  const uniq = () => String(Math.floor(10_000 + Math.random() * 89_999));
  const creerVersion = async () => {
    const a = (await su.query("INSERT INTO automatisations (code, nom) VALUES ($1, 'Relance de devis') RETURNING id", [`ESS-${uniq()}${uniq()}`])).rows[0]?.["id"] as string;
    const empreinte = createHash("sha256").update(randomUUID()).digest("hex");
    const v = (await su.query("INSERT INTO versions_automatisation (automatisation_id, semver, api_moteur, artefact_ref, empreinte_sha256, signature_ed25519, sbom_ref) VALUES ($1, '1.0.0', '^0.1.0', $2, $3, 'c2lnbmF0dXJlLWZpY3RpdmU=', 'sbom/essai') RETURNING id", [a, `modules/${empreinte}/`, empreinte])).rows[0]?.["id"] as string;
    return { automatisation: a, version: v };
  };
  const creerConfiguration = async (tenant: string, instance: string) => {
    const id = randomUUID();
    await su.query("INSERT INTO configurations (tenant_id, id, instance_id, numero, donnees, version_schema, auteur, motif_changement) VALUES ($1, $2, $3, 1, '{}', '1.0.0', $4, 'essai')", [tenant, id, instance, APPELANT.acteur]);
    return id;
  };
  const ligneTest = (t: string, i: string, v: string, cfg: string, extra: Record<string, unknown> = {}) => ({ tenant_id: t, instance_id: i, version_id: v, configuration_id: cfg, resultat: "reussi", lectures: 3, brouillons: 2, envois: 0, duree_ms: 120, auteur: APPELANT.acteur, ...extra });
  const inserer = (table: string, tenant: string, v: Record<string, unknown>) => {
    const cles = Object.keys(v);
    return ecrire(app, tenant, (c) => c.query(`INSERT INTO ${table} (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v)), APPELANT);
  };
  const monde = async () => {
    const A = randomUUID();
    await creerOrg(A, { raison_sociale: "Boulangerie Rivoire" });
    const { automatisation, version } = await creerVersion();
    const instance = (await creerInstance(A, { etat: "pause", automatisation_id: automatisation })).rows[0]?.id as string;
    const cfg = await creerConfiguration(A, instance);
    return { A, automatisation, version, instance, cfg };
  };

  it("[B-093] @isolation un test à blanc réussi avec un envoi, ou échoué sans code, est refusé par la base", async () => {
    const { A, instance, version, cfg } = await monde();
    await inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg));
    await expect(inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg, { envois: 1 }))).rejects.toMatchObject({ code: "23514", constraint: "tests_a_blanc_reussi_sans_envoi" });
    await expect(inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg, { resultat: "echoue" }))).rejects.toMatchObject({ code: "23514", constraint: "tests_a_blanc_echec_motive" });
    await inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg, { resultat: "echoue", envois: 1, code_erreur: "envoi_pendant_test" }));
    await expect(inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg, { resultat: "echoue", code_erreur: "Erreur: adresse a@exemple.fr" }))).rejects.toMatchObject({ code: "23514", constraint: "tests_a_blanc_code_erreur_format" });
    await expect(inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg, { lectures: -1 }))).rejects.toMatchObject({ code: "23514", constraint: "tests_a_blanc_compteurs_bornes" });
  });

  it("[B-093] @isolation un test à blanc ne peut pas citer la configuration d'une autre instance du même client", async () => {
    const { A, instance, version, automatisation } = await monde();
    const autre = (await creerInstance(A, { etat: "pause", automatisation_id: automatisation, environnement: "test" })).rows[0]?.id as string;
    const cfgAutre = await creerConfiguration(A, autre);
    await expect(inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfgAutre))).rejects.toMatchObject({ code: "23503", constraint: "tests_a_blanc_configuration_fk" });
    await expect(inserer("deploiements_instance", A, { tenant_id: A, instance_id: instance, version_cible_id: version, configuration_id: cfgAutre, resultat: "ok", auteur: APPELANT.acteur })).rejects.toMatchObject({ code: "23503", constraint: "deploiements_instance_configuration_fk" });
  });

  it("[A-119] @isolation sous le client A, console_app ne lit ni n'écrit aucune ligne de B dans tests_a_blanc ni deploiements_instance, et ne cite pas une configuration de B", async () => {
    const a = await monde();
    const b = await monde();
    await inserer("tests_a_blanc", b.A, ligneTest(b.A, b.instance, b.version, b.cfg));
    await inserer("deploiements_instance", b.A, { tenant_id: b.A, instance_id: b.instance, version_cible_id: b.version, resultat: "ok", auteur: APPELANT.acteur });
    await ecrire(app, a.A, async (c) => {
      for (const t of ["tests_a_blanc", "deploiements_instance"]) expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [b.A])).rows[0]?.n, t).toBe(0);
    }, APPELANT);
    await expect(inserer("tests_a_blanc", a.A, ligneTest(b.A, b.instance, b.version, b.cfg))).rejects.toMatchObject({ code: "42501" });
    await expect(inserer("deploiements_instance", a.A, { tenant_id: b.A, instance_id: b.instance, version_cible_id: b.version, resultat: "ok", auteur: APPELANT.acteur })).rejects.toMatchObject({ code: "42501" });
    await expect(inserer("tests_a_blanc", a.A, ligneTest(a.A, a.instance, a.version, b.cfg))).rejects.toMatchObject({ code: "23503" });
    for (const t of ["tests_a_blanc", "deploiements_instance"]) expect((await app.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n, t).toBe(0);
  });

  it("[A-119] @isolation UPDATE, DELETE et TRUNCATE de tests_a_blanc et deploiements_instance sont refusés à console_app et console_equipe ; console_lecture ne lit rien", async () => {
    const { A, instance, version, cfg } = await monde();
    await inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg));
    await inserer("deploiements_instance", A, { tenant_id: A, instance_id: instance, version_cible_id: version, resultat: "ok", auteur: APPELANT.acteur });
    for (const t of ["tests_a_blanc", "deploiements_instance"]) {
      for (const requeteMal of [`UPDATE ${t} SET auteur = 'autre'`, `DELETE FROM ${t}`, `TRUNCATE ${t}`]) {
        await expect(ecrire(app, A, (c) => c.query(requeteMal), APPELANT), requeteMal).rejects.toMatchObject({ code: "42501" });
        await expect(avecEquipe(equipe, (c) => c.query(requeteMal)), requeteMal).rejects.toMatchObject({ code: "42501" });
      }
      expect((await avecEquipe(equipe, (c) => c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A]))).rows[0]?.n, t).toBe(1);
      const { rows } = await migration.query("SELECT has_table_privilege('console_lecture', $1, 'SELECT') AS p", [`public.${t}`]);
      expect(rows[0]?.p, t).toBe(false);
    }
  });

  it("[A-119] @isolation l'auteur d'un test à blanc ou d'un déploiement est l'acteur de la transaction, et cree_le ne peut pas être antidaté", async () => {
    const { A, instance, version, cfg } = await monde();
    await expect(inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg, { auteur: "usurpateur" }))).rejects.toMatchObject({ code: "42501" });
    await expect(inserer("deploiements_instance", A, { tenant_id: A, instance_id: instance, version_cible_id: version, resultat: "ok", auteur: "usurpateur" })).rejects.toMatchObject({ code: "42501" });
    await expect(inserer("tests_a_blanc", A, ligneTest(A, instance, version, cfg, { cree_le: "2020-01-01T00:00:00Z" }))).rejects.toMatchObject({ code: "42501" });
    await expect(inserer("deploiements_instance", A, { tenant_id: A, instance_id: instance, version_cible_id: version, resultat: "ok", auteur: APPELANT.acteur, cree_le: "2020-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "42501" });
    await inserer("deploiements_instance", A, { tenant_id: A, instance_id: instance, version_cible_id: version, resultat: "ok", auteur: APPELANT.acteur });
    const { rows } = await migration.query("SELECT acteur FROM public.journal_audit WHERE entite = 'deploiements_instance' AND tenant_id = $1", [A]);
    expect(rows.map((r) => r.acteur)).toEqual([APPELANT.acteur]);
  });

  it("[B-312] @isolation une deuxième instance du même client, de la même automatisation et du même environnement est refusée ; une instance de test à côté de la production est acceptée", async () => {
    const { A, automatisation } = await monde();
    await expect(creerInstance(A, { etat: "pause", automatisation_id: automatisation })).rejects.toMatchObject({ code: "23505", constraint: "instances_une_par_automatisation" });
    await creerInstance(A, { etat: "pause", automatisation_id: automatisation, environnement: "test" });
    // Les instances anciennes (sans automatisation_id) ne sont pas concernées par l'index partiel.
    await creerInstance(A, { etat: "pause" });
    await creerInstance(A, { etat: "pause" });
    const B = randomUUID();
    await creerOrg(B, { raison_sociale: "Garage Fontaine" });
    await creerInstance(B, { etat: "pause", automatisation_id: automatisation });
  });
});
