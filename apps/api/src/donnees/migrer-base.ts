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
// `module` : code d'un module (schéma a_<code> de la base du client, T2-35) ; les migrations du dossier sont alors celles de CE module (jamais le modèle).
export type Options = { url: string; dossier?: string; module?: string };

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

// Migrations d'un module (T2-35) : seulement dans le schéma a_<code>. Le rôle propriétaire possède aussi commun et public : la barrière est donc le texte (refus avant toute exécution)
// PUIS le comptage des objets hors du schéma avant et après chaque migration (refus avant COMMIT). Rien n'est jamais détruit ni écrit hors de a_<code>.
const CODE_MODULE = /^[a-z][a-z0-9_]{1,30}$/;
const SCHEMAS_PROTEGES = "commun|public|trace|pg_catalog|pg_temp|information_schema|pgbouncer|provisionnement";
const REGLES_MODULE: [RegExp, string][] = [
  [/\bsearch_path\b|\bset_config\b/i, "changement du chemin de recherche"],
  [/\b(set|reset)\s+(local\s+|session\s+)?(role|session\s+authorization|all)\b/i, "changement de rôle ou de session"],
  [/\b(alter|create|drop)\s+(role|user|group|database|schema|extension|tablespace|server|foreign|publication|subscription|event\s+trigger|system|default\s+privileges|owned)\b/i, "ordre d'administration"],
  [/\b(grant|revoke|reassign|security\s+definer)\b/i, "droits ou propriété"],
  [/\bset\s+schema\b|\b(do|execute|copy|listen|notify|load|call)\b|\bpg_[a-z_]+\s*\(|\blo_[a-z_]+\s*\(|\bdblink/i, "exécution dynamique, fichier ou fonction système"],
  [new RegExp(`(?:^|[^a-z0-9_])"?(${SCHEMAS_PROTEGES})"?\\s*\\.`, "i"), "schéma protégé"],
];
export function verifierMigrationModule(sql: string, code: string): string[] {
  if (typeof code !== "string" || !CODE_MODULE.test(code)) throw new Error("migrerBase : code de module invalide");
  const refus = REGLES_MODULE.filter(([re]) => re.test(sql)).map(([, motif]) => `migration de module refusée : ${motif}`);
  for (const m of sql.matchAll(/(?:^|[^a-z0-9_])"?(a_[a-z0-9_]+)"?\s*\./gi)) if (m[1]!.toLowerCase() !== `a_${code}`) refus.push("migration de module refusée : schéma d'un autre module");
  return refus;
}
const comptesHors = async (client: pg.Client, schema: string): Promise<string> =>
  (await client.query<{ n: string }>(
    "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname <> $1 AND s.nspname NOT LIKE 'pg\\_toast%') || '/' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname <> $1) || '/' || (SELECT count(*) FROM pg_namespace) AS n",
    [schema],
  )).rows[0]!.n;

async function appliquerModule(client: pg.Client, nomBase: string, dossier: string, versionCible: number, code: string): Promise<void> {
  const schema = `a_${code}`;
  const entrees = lireEntrees(dossier);
  const refus = entrees.flatMap((e) => verifierMigrationModule(readFileSync(`${dossier}/${e.tag}.sql`, "utf8"), code).map((r) => `${e.tag} : ${r}`));
  if (refus.length) throw new Error(`migrations de module refusées :\n${refus.join("\n")}`);
  const { rows } = await client.query<{ role: string }>("SELECT session_user AS role");
  if (!rows[0] || ROLE_INTERDIT.test(rows[0].role)) throw new Error(`migrerBase refuse le rôle de session « ${rows[0]?.role} »`);
  await client.query("SET standard_conforming_strings = on; SET client_encoding = 'UTF8'");
  await client.query(`SET ROLE ${citer(`${nomBase}_proprietaire`)}`);
  await client.query("SELECT pg_advisory_lock($1)", [VERROU_MIGRATION_BASE.toString()]);
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${citer(schema)}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${citer(schema)}.version_structure (version integer PRIMARY KEY CHECK (version >= 1), appliquee_le timestamptz NOT NULL DEFAULT now(), empreinte text NOT NULL)`);
    const deja = (await client.query<Appliquee>(`SELECT version, empreinte FROM ${citer(schema)}.version_structure`)).rows;
    for (const m of migrationsAAppliquer(entrees, deja, versionCible)) {
      await client.query("BEGIN");
      try {
        const avant = await comptesHors(client, schema);
        await client.query(`SET LOCAL search_path = ${citer(schema)}`);
        for (const morceau of readFileSync(`${dossier}/${m.tag}.sql`, "utf8").split(MARQUEUR)) if (morceau.trim()) await client.query(morceau);
        if ((await comptesHors(client, schema)) !== avant) throw new Error(`migrerBase : la migration ${m.tag} a créé un objet hors de ${schema}`);
        await client.query(`INSERT INTO ${citer(schema)}.version_structure (version, empreinte) VALUES ($1, $2)`, [m.version, m.empreinte]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    }
    // Droits posés par le propriétaire, jamais par le module : l'application lit et écrit sans DELETE, la lecture lit.
    const presents = (await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [[`${nomBase}_app`, `${nomBase}_lecture`]])).rows.map((r) => r.rolname);
    for (const r of presents) {
      const ecrit = r.endsWith("_app");
      await client.query(`GRANT USAGE ON SCHEMA ${citer(schema)} TO ${citer(r)}`);
      await client.query(`GRANT ${ecrit ? "SELECT, INSERT, UPDATE" : "SELECT"} ON ALL TABLES IN SCHEMA ${citer(schema)} TO ${citer(r)}`);
      if (ecrit) await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${citer(schema)} TO ${citer(r)}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [VERROU_MIGRATION_BASE.toString()]).catch(() => undefined);
  }
}

export async function migrerBase(nomBase: string, versionCible: number, options: Options): Promise<void> {
  if (!NOM_BASE.test(nomBase)) throw new Error("migrerBase : nom de base invalide (attendu cli_ suivi de 12 caractères hexadécimaux)");
  verifierRole(nomBase, options.url);
  if (options.module !== undefined) {
    // Le code du module est validé avant toute connexion ; le dossier de migrations du module est obligatoire (jamais celui du modèle).
    if (!options.dossier) throw new Error("migrerBase : dossier de migrations du module absent");
    verifierMigrationModule("", options.module);
  }
  const client = new pg.Client({ connectionString: options.url });
  await client.connect();
  try {
    if (options.module !== undefined) return await appliquerModule(client, nomBase, options.dossier!, versionCible, options.module);
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
