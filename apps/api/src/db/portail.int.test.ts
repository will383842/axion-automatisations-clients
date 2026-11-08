import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { controlerInvariants, type Requete } from "../../../../packages/contrats/src/c5/invariants.js";
import { avecClient } from "./client-actif.js";
import { migrer } from "./migrer.js";
import { ecrirePreference, lirePreferences } from "../portail/notifications.js";

// Migration 0025 (T6-01a) : tables du portail dans console. Socle lancé par ops/socle/lancer.sh (job socle-integration).
// Les essais tournent en parallèle sur une base partagée : identifiants tirés au hasard.
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
const OPTIONS = { rolesApplication: /^(console|moteur)_(app|equipe|lecture)$/ };
const requete: Requete = async (sql) => (await migration.query(`SELECT coalesce(json_agg(t), '[]') AS r FROM (${sql}) t`)).rows[0]?.["r"] as Record<string, unknown>[];
const APPELANT = { acteur: "agent-essai" };

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
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "?");
const empreinte = () => createHash("sha256").update(randomUUID()).digest("hex");
const creerOrg = (id: string) =>
  ecrire(app, id, (c) => c.query("INSERT INTO organisations (id, tenant_id, console_client_id, raison_sociale) VALUES ($1, $1, $1, 'Atelier Bertin')", [id]), APPELANT);
const poserInvitation = (A: string, extra: { jours?: number; hex?: string } = {}) =>
  ecrire(
    app,
    A,
    (c) =>
      c.query(
        "INSERT INTO invitations (tenant_id, id, organisation_id, role, empreinte_invitation, expire_le, cree_le, invite_par) VALUES ($1, $2, $1, 'utilisateur', $3, now() + make_interval(days => $4), now(), $5) RETURNING id",
        [A, randomUUID(), extra.hex ?? empreinte(), extra.jours ?? 7, randomUUID()],
      ),
    APPELANT,
  );
const compter = (tenant: string, table: string) => ecrire(app, tenant, async (c) => Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n));

beforeAll(async () => {
  try {
    await migrer({ url: `postgres://console_migration:${motDePasseDe("console_migration")}@${DIRECT.host}:${DIRECT.port}/console`, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (e) {
    const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message?: string; detail?: string; constraint?: string; table?: string };
    writeSync(2, `ECHEC-MIGRATION 0025 : code=${c.code ?? "?"} message=${String(c.message ?? "").slice(0, 300)} detail=${String(c.detail ?? "").slice(0, 200)} contrainte=${c.constraint ?? ""} table=${c.table ?? ""}\n`);
    throw e;
  }
}, 120_000);
afterAll(async () => {
  await Promise.all(ouverts.map((o) => o.end().catch(() => undefined)));
});
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `ECHEC ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 400)}\n`);
});

describe("migration 0025 : tables du portail, avec le socle", { timeout: 120_000 }, () => {
  it("[LOT6-tables] @isolation invitations, progression et préférences de A invisibles depuis B", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await poserInvitation(A);
    await ecrire(app, A, (c) => c.query("INSERT INTO progression_premiers_pas (tenant_id, id, organisation_id, utilisateur, etape) VALUES ($1, $2, $1, $3, 'bienvenue')", [A, randomUUID(), randomUUID()]), APPELANT);
    await ecrire(app, A, (c) => c.query("INSERT INTO preferences_notifications (tenant_id, id, utilisateur, cle_envoi) VALUES ($1, $2, $3, 'rapport.mensuel')", [A, randomUUID(), randomUUID()]), APPELANT);
    for (const t of ["invitations", "progression_premiers_pas", "preferences_notifications"]) {
      expect(await compter(A, t), t).toBe(1);
      expect(await compter(B, t), t).toBe(0);
    }
    // B ne peut ni insérer une ligne au nom de A, ni modifier celle de A.
    expect(await code(ecrire(app, B, (c) => c.query("INSERT INTO invitations (tenant_id, id, organisation_id, role, empreinte_invitation, expire_le, invite_par) VALUES ($1, $2, $1, 'utilisateur', $3, now() + interval '1 day', $4)", [A, randomUUID(), empreinte(), randomUUID()]), APPELANT))).toBe("42501");
    expect(await ecrire(app, B, async (c) => (await c.query("UPDATE invitations SET etat = 'revoquee'")).rowCount, APPELANT)).toBe(0);
  });

  it("[LOT6-tables] @isolation accords_logo et compteurs_ecrans de A invisibles depuis B", async () => {
    const A = randomUUID(), B = randomUUID();
    await creerOrg(A);
    await creerOrg(B);
    await ecrire(app, A, (c) => c.query("INSERT INTO accords_logo (tenant_id, id, organisation_id, confirme_par, reference_preuve) VALUES ($1, $2, $1, $3, 'preuve-essai-1')", [A, randomUUID(), randomUUID()]), APPELANT);
    await ecrire(app, A, (c) => c.query("INSERT INTO compteurs_ecrans (tenant_id, id, organisation_id, ecran, jour) VALUES ($1, $2, $1, 'accueil', current_date)", [A, randomUUID()]), APPELANT);
    for (const t of ["accords_logo", "compteurs_ecrans"]) {
      expect(await compter(A, t), t).toBe(1);
      expect(await compter(B, t), t).toBe(0);
    }
  });

  it("[LOT6-tables] une invitation acceptée ne se réaccepte pas", async () => {
    const A = randomUUID();
    await creerOrg(A);
    const id = ((await poserInvitation(A)).rows[0] as { id: string }).id;
    const accepter = () => ecrire(app, A, async (c) => (await c.query("UPDATE invitations SET etat = 'acceptee', acceptee_le = now() WHERE id = $1", [id])).rowCount, APPELANT);
    expect(await accepter()).toBe(1);
    expect(await accepter()).toBe(0);
  });

  it("[LOT6-tables] expiration à plus de 30 jours refusée", async () => {
    const A = randomUUID();
    await creerOrg(A);
    expect(await code(poserInvitation(A, { jours: 31 }))).toBe("23514");
    expect(await code(poserInvitation(A, { jours: 30 }))).toBe("ok");
  });

  it("[LOT6-tables] échec fermé : sans client actif rien n'est lu, une empreinte hors forme et un DELETE sont refusés", async () => {
    const A = randomUUID();
    await creerOrg(A);
    expect((await app.query("SELECT count(*) AS n FROM invitations")).rows[0]?.n).toBe("0");
    expect(await code(poserInvitation(A, { hex: "jeton-en-clair" }))).toBe("23514");
    expect(await code(ecrire(app, A, (c) => c.query("DELETE FROM invitations"), APPELANT))).toBe("42501");
  });

  it("[LOT6-tables] invariants C5 sans écart après la migration", async () => {
    const ecarts = await controlerInvariants(requete, "console", OPTIONS);
    expect(ecarts.filter((e) => /progression_premiers_pas|preferences_notifications|invitations|accords_logo|compteurs_ecrans/.test(e.objet))).toEqual([]);
  });

  it("[B-186] l'écriture d'une préférence pose acteur et maj_le, et une seconde écriture met à jour la même ligne", async () => {
    const A = randomUUID();
    const utilisateur = randomUUID();
    await creerOrg(A);
    await ecrire(app, A, (c) => ecrirePreference(c, A, utilisateur, "brouillonEnAttente", false), { acteur: utilisateur });
    await ecrire(app, A, (c) => ecrirePreference(c, A, utilisateur, "brouillonEnAttente", true), { acteur: utilisateur });
    const lignes = await ecrire(app, A, async (c) => (await c.query("SELECT activee FROM preferences_notifications WHERE utilisateur = $1 AND cle_envoi = 'brouillon_en_attente'", [utilisateur])).rows);
    expect(lignes).toEqual([{ activee: true }]);
  });

  it("[B-141] un utilisateur ne lit pas les préférences d'un collègue du même client", async () => {
    const A = randomUUID();
    const u1 = randomUUID();
    const u2 = randomUUID();
    await creerOrg(A);
    await ecrire(app, A, (c) => ecrirePreference(c, A, u2, "rapportMensuel", false), { acteur: u2 });
    expect(await ecrire(app, A, (c) => lirePreferences(c, A, u1))).toEqual({ desactivees: [], resumeHebdomadaire: false });
    expect((await ecrire(app, A, (c) => lirePreferences(c, A, u2))).desactivees).toEqual(["rapportMensuel"]);
  });
});
