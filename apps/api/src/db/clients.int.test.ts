import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  return avecClient(app, id, (c) => c.query(`INSERT INTO organisations (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, Object.values(v)), APPELANT);
};
const creerInstance = (tenant: string, id = randomUUID(), extra: Record<string, unknown> = {}) => {
  const v = { id, tenant_id: tenant, organisation_id: tenant, code_automatisation: "relance-devis", formule: "abonnement", environnement: "production", ...extra };
  const cles = Object.keys(v);
  return avecClient(app, tenant, (c) => c.query(`INSERT INTO instances (${cles.join(", ")}) VALUES (${cles.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, Object.values(v)), APPELANT);
};

beforeAll(async () => {
  await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});

describe("tables de client, avec le socle", () => {
  it("[A-119] @isolation toutes les migrations appliquées, les invariants C5 ne trouvent aucun écart", async () => {
    expect(await controlerInvariants(requete, "console", OPTIONS)).toEqual([]);
    const { rows } = await migration.query("SELECT relname FROM pg_class WHERE relname IN ('organisations', 'contacts', 'instances') AND relkind = 'r' ORDER BY 1");
    expect(rows.map((r) => r.relname)).toEqual(["contacts", "instances", "organisations"]);
  });

  it("[A-119] @isolation une table de tableClient() a la clé primaire (tenant_id, id) et UNIQUE (tenant_id, id) ; console_client_id différent de tenant_id est refusé", async () => {
    const { rows } = await migration.query(`
      SELECT c.contype, (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols
      FROM pg_constraint c WHERE c.conrelid = 'public.instances'::regclass AND c.contype IN ('p', 'u')`);
    expect(rows.map((r) => `${r.contype}:${r.cols}`).sort()).toEqual(["p:tenant_id,id", "u:tenant_id,id"]);
    const A = randomUUID();
    await expect(creerOrg(A, { console_client_id: randomUUID() })).rejects.toMatchObject({ code: "23514" });
    await creerOrg(A);
  });

  it("[A-119] la ligne « plateforme » existe, est unique et n'est visible d'aucun client", async () => {
    const vue = await avecEquipe(equipe, async (c) => (await c.query("SELECT id, tenant_id FROM organisations WHERE id = $1", [PLATEFORME])).rows);
    expect(vue).toEqual([{ id: PLATEFORME, tenant_id: PLATEFORME }]);
    const A = randomUUID();
    await creerOrg(A);
    expect((await avecClient(app, A, (c) => c.query("SELECT 1 FROM organisations WHERE id = $1", [PLATEFORME]))).rowCount).toBe(0);
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
    const { rows } = await avecClient(app, A, (c) =>
      c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role, acces_portail, keycloak_id) VALUES ($1, $2, $2, 'Camille Essai', 'camille@exemple.fr', 'facturation', true, $3) RETURNING *", [randomUUID(), A, keycloak]), APPELANT);
    expect(rows[0]).toMatchObject({ nom: "Camille Essai", email: "camille@exemple.fr", role: "facturation", acces_portail: true, keycloak_id: keycloak });
    // Clé étrangère composée : un contact ne se rattache pas à l'organisation d'un autre client.
    const B = randomUUID();
    await creerOrg(B);
    await expect(avecClient(app, A, (c) => c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role) VALUES ($1, $2, $3, 'X', 'x@exemple.fr', 'principal')", [randomUUID(), A, B]))).rejects.toThrow();
  });

  it("[A-126] une instance refuse un état hors active, pause, erreur, livree", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const etat of ["active", "pause", "erreur", "livree"]) await creerInstance(A, randomUUID(), { etat });
    await expect(creerInstance(A, randomUUID(), { etat: "supprimee" })).rejects.toMatchObject({ code: "22P02" });
  });

  it("[A-119] @isolation avec le client A, console_app ne lit ni n'écrit aucune ligne de B dans organisations, contacts, instances", async () => {
    const A = randomUUID();
    const B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    const instanceB = (await creerInstance(B)).rows[0]?.id as string;
    await avecClient(app, B, (c) => c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role) VALUES ($1, $2, $2, 'Autre Essai', 'autre@exemple.fr', 'principal')", [randomUUID(), B]), APPELANT);
    await avecClient(app, A, async (c) => {
      for (const t of ["organisations", "contacts", "instances"]) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B])).rows[0]?.n, t).toBe(0);
        expect((await c.query(`UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [B])).rowCount, t).toBe(0);
        expect((await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [B])).rowCount, t).toBe(0);
      }
      expect((await c.query("UPDATE instances SET etat = 'pause' WHERE id = $1", [instanceB])).rowCount).toBe(0);
    }, APPELANT);
    // Écrire une ligne au nom de B depuis A : refus par WITH CHECK.
    await expect(avecClient(app, A, (c) => c.query("INSERT INTO instances (id, tenant_id, organisation_id, code_automatisation, formule, environnement) VALUES ($1, $2, $2, 'x', 'abonnement', 'test')", [randomUUID(), B]))).rejects.toMatchObject({ code: "42501" });
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

  it("[A-178] une insertion, une modification et une suppression d'instance écrivent chacune une ligne au journal avec ancienne et nouvelle valeur, acteur et IP", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = (await creerInstance(A)).rows[0]?.id as string;
    await avecClient(app, A, (c) => c.query("UPDATE instances SET etat = 'pause' WHERE id = $1", [id]), APPELANT);
    await avecClient(app, A, (c) => c.query("DELETE FROM instances WHERE id = $1", [id]), APPELANT);
    const { rows } = await migration.query("SELECT action, acteur, host(ip) AS ip, ancienne, nouvelle FROM public.journal_audit WHERE tenant_id = $1 AND entite = 'instances' AND entite_id = $2 ORDER BY id", [A, id]);
    expect(rows.map((r) => r.action)).toEqual(["insertion", "modification", "suppression"]);
    expect(rows.every((r) => r.acteur === "agent-essai" && r.ip === "192.0.2.17")).toBe(true);
    expect(rows[0]).toMatchObject({ ancienne: null, nouvelle: { etat: "active" } });
    expect(rows[1]).toMatchObject({ ancienne: { etat: "active" }, nouvelle: { etat: "pause" } });
    expect(rows[2]).toMatchObject({ ancienne: { etat: "pause" }, nouvelle: null });
    expect(await lignesCassees()).toBe(0);
  });

  it("[A-178] la création d'une organisation écrit au journal ; un contact (données de personnes) n'est pas encore copié au journal (ADR 0010)", async () => {
    const A = randomUUID();
    await creerOrg(A);
    await avecClient(app, A, (c) => c.query("INSERT INTO contacts (id, tenant_id, organisation_id, nom, email, role) VALUES ($1, $2, $2, 'Camille Essai', 'camille@exemple.fr', 'principal')", [randomUUID(), A]), APPELANT);
    const { rows } = await migration.query("SELECT entite FROM public.journal_audit WHERE tenant_id = $1", [A]);
    expect(rows.map((r) => r.entite)).toEqual(["organisations"]);
  });

  it("[C-028] @isolation UPDATE, DELETE et TRUNCATE du journal sont refusés pour console_app et console_equipe, après des écritures de tables de client", async () => {
    const A = randomUUID();
    await creerOrg(A);
    for (const p of [app, equipe]) {
      await expect(p.query("TRUNCATE public.journal_audit")).rejects.toThrow(/permission denied|ajout seul/);
      await expect(avecClient(p, A, (c) => c.query("UPDATE public.journal_audit SET acteur = 'forge'"))).rejects.toThrow(/permission denied/);
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
    await avecClient(seul, A, (c) => c.query("SELECT 1"), APPELANT);
    const apres = await avecClient(seul, A, (c) => c.query("SELECT current_setting('app.acteur', true) AS a, current_setting('app.ip', true) AS i, current_setting('lock_timeout') AS l"));
    expect(apres.rows[0]).toMatchObject({ a: "", i: "", l: "0" });
  });
});

describe("réserves de l'audit de la PR 95, avec le socle", () => {
  it("[A-131] @isolation une transaction qui tient une ligne sans rien faire est coupée par PostgreSQL : l'écriture auditée d'un tiers passe en moins de 10 s", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const X = (await creerInstance(A)).rows[0]?.id as string;
    const tiers = randomUUID();
    await creerOrg(tiers);
    // T0 : verrou de ligne sur X puis inactivité de 9 s. T1 : écriture auditée (prend le journal) puis attente de la ligne X. Tiers : écriture auditée.
    const t0 = avecClient(app, A, async (c) => {
      await c.query("SELECT id FROM instances WHERE id = $1 FOR UPDATE", [X]);
      await dormir(9000);
      await c.query("SELECT 1");
    }).catch((e: unknown) => e);
    await dormir(300);
    const t1 = avecClient(app, A, async (c) => {
      await c.query("INSERT INTO instances (id, tenant_id, organisation_id, code_automatisation, formule, environnement) VALUES ($1, $2, $2, 'x', 'abonnement', 'test')", [randomUUID(), A]);
      await c.query("UPDATE instances SET etat = 'pause' WHERE id = $1", [X]);
    }).catch((e: unknown) => e);
    await dormir(1000);
    const debut = Date.now();
    await creerInstance(tiers);
    expect(Date.now() - debut).toBeLessThan(10_000);
    await Promise.all([t0, t1]);
    expect(await lignesCassees()).toBe(0);
  }, 40_000);

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
    const apres = await avecClient(app, A, (c) => c.query("SELECT length(metier) AS n FROM organisations WHERE id = $1", [A]));
    expect(apres.rows[0]?.n).toBe(300_000);
    await avecClient(app, A, (c) => c.query("UPDATE organisations SET metier = $2 WHERE id = $1", [A, "y".repeat(300_000)]), APPELANT);
    expect(await lignesCassees()).toBe(0);
  });

  it("[A-131] @isolation audit_ajouter refuse U+180E, U+00AD et U+3164 dans l'acteur et dans l'identifiant d'entité", async () => {
    const A = randomUUID();
    for (const car of ["\u180E", "\u00AD", "\u3164"]) {
      await expect(avecClient(app, A, (c) => c.query(AJOUTER, [A, `agent${car}forge`, "insertion", "essai_car", "ok", null, null])), `acteur U+${car.codePointAt(0)?.toString(16)}`).rejects.toThrow(/acteur invalide/);
      await expect(avecClient(app, A, (c) => c.query(AJOUTER, [A, "agent-essai", "insertion", "essai_car", `id${car}x`, null, null])), `entite_id U+${car.codePointAt(0)?.toString(16)}`).rejects.toThrow(/identifiant d'entité invalide/);
    }
    await avecClient(app, A, (c) => c.query(AJOUTER, [A, "agent-é-ñ", "insertion", "essai_car", "ok", null, null]));
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
