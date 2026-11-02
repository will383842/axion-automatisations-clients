import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { verifierDossier } from "../../../../scripts/garde-migrations.ts";

// Outil de migration des bases des clients (T2-32, ADR 0046) : applique apps/api/drizzle-cli/ avec le rôle PROPRIÉTAIRE de la base, jamais _app ni _lecture.
// Le journal des migrations de chaque base est public.version_structure (A-225) : une ligne par migration, avec l'empreinte du fichier.
// Connexion DIRECTE à la grappe « données » (verrou de session, DDL) : jamais PgBouncer en mode transaction.
export const DOSSIER_CLI = fileURLToPath(new URL("../../drizzle-cli", import.meta.url));
export const VERROU_MIGRATION_BASE = 7_410_020_241_032n;
const NOM_BASE = /^cli_[0-9a-f]{12}$/;
const ROLE_INTERDIT = /_(app|lecture|equipe)$/;
const MARQUEUR = "--> statement-breakpoint";
const ROLE_MODELE = "modele_proprietaire";

export type EntreeMigration = { version: number; tag: string; empreinte: string };
export type Appliquee = { version: number; empreinte: string };
export type Options = { url: string; dossier?: string };

// Entrées du journal drizzle, dans l'ordre : la version N est la N-ième migration (la première vaut 1).
export function lireEntrees(dossier: string): EntreeMigration[] {
  if (!existsSync(`${dossier}/meta/_journal.json`)) return [];
  const journal = JSON.parse(readFileSync(`${dossier}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
  return journal.entries.map((e, i) => ({ version: i + 1, tag: e.tag, empreinte: createHash("sha256").update(readFileSync(`${dossier}/${e.tag}.sql`)).digest("hex") }));
}

// Migrations manquantes jusqu'à la version cible, dans l'ordre. Refuse : version cible inconnue, trou dans les versions déjà appliquées, fichier modifié après coup.
export function migrationsAAppliquer(entrees: EntreeMigration[], appliquees: Appliquee[], versionCible: number): EntreeMigration[] {
  if (!Number.isInteger(versionCible) || versionCible < 1 || versionCible > entrees.length) throw new Error(`migrerBase : version cible ${versionCible} inconnue (1 à ${entrees.length})`);
  const deja = new Map(appliquees.map((a) => [a.version, a.empreinte]));
  const derniere = Math.max(0, ...deja.keys());
  for (let v = 1; v <= derniere; v++) {
    if (!deja.has(v)) throw new Error(`migrerBase : trou dans version_structure (version ${v} absente, ${derniere} présente)`);
    const attendue = entrees[v - 1]?.empreinte;
    if (attendue !== deja.get(v)) throw new Error(`migrerBase : empreinte différente pour la version ${v} (fichier de migration modifié après application)`);
  }
  return entrees.filter((e) => e.version > derniere && e.version <= versionCible);
}

function lireUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error("migrerBase : adresse de connexion illisible");
  }
}
// Avant toute connexion : le rôle de l'adresse ne doit pas être celui de l'application, de la lecture ou de l'équipe ; connexion directe seulement.
export function verifierRole(nomBase: string, url: string): void {
  const u = lireUrl(url);
  const role = decodeURIComponent(u.username);
  if (!role || ROLE_INTERDIT.test(role)) throw new Error(`migrerBase refuse le rôle « ${role} » : les migrations passent par le rôle propriétaire de ${nomBase}, jamais par un rôle d'application`);
  if (u.port === "6432" || u.hostname.toLowerCase().includes("pgbouncer")) throw new Error("migrerBase exige une connexion directe à PostgreSQL, pas PgBouncer");
}

const citer = (nom: string) => `"${nom.replaceAll('"', '""')}"`;

// Applique les migrations manquantes dans une transaction par migration, sous verrou ; `proprietaire` est le rôle dont la session prend l'identité.
async function appliquer(client: pg.Client, proprietaire: string, dossier: string, versionCible: number): Promise<void> {
  const refus = verifierDossier(dossier);
  if (refus.length) throw new Error(`migrations refusées :\n${refus.join("\n")}`);
  const { rows } = await client.query<{ role: string }>("SELECT session_user AS role");
  if (!rows[0] || ROLE_INTERDIT.test(rows[0].role)) throw new Error(`migrerBase refuse le rôle de session « ${rows[0]?.role} »`);
  await client.query("SET standard_conforming_strings = on; SET client_encoding = 'UTF8'");
  await client.query(`SET ROLE ${citer(proprietaire)}`);
  const actuel = (await client.query<{ r: string }>("SELECT current_user AS r")).rows[0]?.r;
  if (actuel !== proprietaire) throw new Error(`migrerBase : le rôle ${proprietaire} n'a pas pu être pris`);
  await client.query("SELECT pg_advisory_lock($1)", [VERROU_MIGRATION_BASE.toString()]);
  try {
    const existe = (await client.query<{ t: string | null }>("SELECT to_regclass('public.version_structure')::text AS t")).rows[0]?.t;
    const deja = existe ? (await client.query<{ version: number; empreinte: string }>("SELECT version, empreinte FROM public.version_structure")).rows : [];
    for (const m of migrationsAAppliquer(lireEntrees(dossier), deja, versionCible)) {
      await client.query("BEGIN");
      try {
        for (const morceau of readFileSync(`${dossier}/${m.tag}.sql`, "utf8").split(MARQUEUR)) if (morceau.trim()) await client.query(morceau);
        await client.query("INSERT INTO public.version_structure (version, empreinte) VALUES ($1, $2)", [m.version, m.empreinte]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [VERROU_MIGRATION_BASE.toString()]).catch(() => undefined);
  }
}

// Droits de `cli_<id>_app` (lit et écrit commun, sans DELETE ni UPDATE sur les exclusions ; insère dans trace) et de `cli_<id>_lecture` (lit), posés par le propriétaire après les migrations.
// GRANT d'un rôle qui ne possède pas l'objet n'échoue pas : il avertit et ne donne rien. On relit donc les droits et on refuse s'ils manquent.
async function poserDroits(client: pg.Client, nomBase: string): Promise<void> {
  const [app, lecture] = [`${nomBase}_app`, `${nomBase}_lecture`];
  const presents = (await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [[app, lecture]])).rows.map((r) => r.rolname);
  const grants: string[] = [];
  if (presents.includes(app)) {
    grants.push(`GRANT USAGE ON SCHEMA commun, trace TO ${citer(app)}`, `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA commun TO ${citer(app)}`, `REVOKE UPDATE ON commun.exclusions FROM ${citer(app)}`, `GRANT INSERT ON trace.evenements TO ${citer(app)}`, `GRANT SELECT ON public.version_structure TO ${citer(app)}`);
  }
  if (presents.includes(lecture)) {
    grants.push(`GRANT USAGE ON SCHEMA commun, trace TO ${citer(lecture)}`, `GRANT SELECT ON ALL TABLES IN SCHEMA commun, trace TO ${citer(lecture)}`, `GRANT SELECT ON public.version_structure TO ${citer(lecture)}`);
  }
  for (const g of grants) await client.query(g);
  const attendus: [string, string, string][] = [[app, "commun.personnes", "INSERT"], [app, "trace.evenements", "INSERT"], [lecture, "commun.personnes", "SELECT"], [lecture, "trace.evenements", "SELECT"]];
  // Règles de Will : aucun DELETE accordé, une opposition (exclusions) ne s'efface ni ne se modifie. Droits à relire, pas seulement à poser.
  const interdits: [string, string, string][] = [];
  for (const role of presents) for (const table of ["commun.personnes", "commun.listes_prospects_personnes", "commun.exclusions", "trace.evenements"]) interdits.push([role, table, "DELETE"]);
  if (presents.includes(app)) interdits.push([app, "commun.exclusions", "UPDATE"]);
  for (const [role, table, droit] of interdits) {
    const ok = (await client.query<{ ok: boolean }>("SELECT has_table_privilege($1, $2, $3) AS ok", [role, table, droit])).rows[0]?.ok;
    if (ok) throw new Error(`migrerBase : ${role} a le droit ${droit} sur ${table}, interdit`);
  }
  for (const [role, table, droit] of attendus) {
    if (!presents.includes(role)) continue;
    const ok = (await client.query<{ ok: boolean }>("SELECT has_table_privilege($1, $2, $3) AS ok", [role, table, droit])).rows[0]?.ok;
    if (!ok) throw new Error(`migrerBase : ${role} n'a pas le droit ${droit} sur ${table} (les objets de la base doivent appartenir au rôle propriétaire du client)`);
  }
}

export async function migrerBase(nomBase: string, versionCible: number, options: Options): Promise<void> {
  if (!NOM_BASE.test(nomBase)) throw new Error("migrerBase : nom de base invalide (attendu cli_ suivi de 12 caractères hexadécimaux)");
  verifierRole(nomBase, options.url);
  const client = new pg.Client({ connectionString: options.url });
  await client.connect();
  try {
    await appliquer(client, `${nomBase}_proprietaire`, options.dossier ?? DOSSIER_CLI, versionCible);
    await poserDroits(client, nomBase);
  } finally {
    await client.end();
  }
}

// Crée modele_v<N> sur la grappe « données » depuis les migrations, puis le ferme : IS_TEMPLATE, aucune connexion. Refuse si la base existe (rien n'est détruit).
// `options.url` : rôle de la grappe qui peut créer des bases (le provisionneur), vers la base d'administration. Les objets du modèle appartiennent à modele_proprietaire.
export async function construireModele(n: number, options: Options): Promise<void> {
  if (!Number.isInteger(n) || n < 1 || n > 999_999) throw new Error("construireModele : numéro de modèle invalide");
  verifierRole("modele", options.url);
  const nom = `modele_v${n}`;
  const admin = new pg.Client({ connectionString: options.url });
  await admin.connect();
  try {
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [nom])).rowCount) throw new Error(`construireModele : ${nom} existe déjà`);
    if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE_MODELE])).rowCount) await admin.query(`CREATE ROLE ${ROLE_MODELE} NOLOGIN NOBYPASSRLS`);
    await admin.query(`GRANT ${ROLE_MODELE} TO CURRENT_USER WITH SET TRUE`);
    await admin.query(`CREATE DATABASE ${citer(nom)} OWNER ${ROLE_MODELE}`);
    // Fermé tout de suite : personne d'autre que le propriétaire ne se connecte au modèle pendant sa construction.
    await admin.query(`REVOKE CONNECT ON DATABASE ${citer(nom)} FROM PUBLIC`);
    const u = lireUrl(options.url);
    u.pathname = `/${nom}`;
    const modele = new pg.Client({ connectionString: u.toString() });
    await modele.connect();
    try {
      await appliquer(modele, ROLE_MODELE, options.dossier ?? DOSSIER_CLI, lireEntrees(options.dossier ?? DOSSIER_CLI).length);
    } finally {
      await modele.end();
    }
    // La dernière version est notée en commentaire de la base : le modèle est fermé, la recette (T2-34) ne peut pas lire version_structure.
    const derniere = lireEntrees(options.dossier ?? DOSSIER_CLI).length;
    await admin.query(`COMMENT ON DATABASE ${citer(nom)} IS 'version_structure=${derniere}'`);
    await admin.query(`ALTER DATABASE ${citer(nom)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  } finally {
    await admin.end();
  }
}
