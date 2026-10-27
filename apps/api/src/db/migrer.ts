import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { TABLE_MIGRATIONS } from "../../../../packages/contrats/src/c5/invariants.ts";
import { verifierDossier } from "../../../../scripts/garde-migrations.ts";

// Outil de migration : applique apps/api/drizzle/ avec console_migration, jamais console_app.
// Le journal des migrations appliquées est public.__migrations (TABLE_MIGRATIONS, la table que les invariants C5 exemptent), pas drizzle.__drizzle_migrations.
// Il doit rester là dès la première migration réelle : le déplacer plus tard ferait rejouer les migrations.
const ROLE = "console_migration";
export const JOURNAL_PAR_DEFAUT = Object.freeze({ schema: "public", table: TABLE_MIGRATIONS });
// Verrou consultatif de session : deux migrer() (deux conteneurs au démarrage, essais en parallèle) s'attendent au lieu de se disputer le journal.
// Il suppose une connexion DIRECTE à PostgreSQL, jamais PgBouncer en mode transaction (le verrou et le DDL y sont perdus ou partagés).
export const VERROU_MIGRATION = 7_410_020_241_027n;
const NOM_JOURNAL = /^[a-z0-9_]+$/;

// Drizzle saute en silence toute migration dont la date est sous celle de la dernière appliquée. Une entrée du journal dans ce cas, sans ligne au même hash, serait perdue : on la signale.
export function migrationsSautees(entrees: { tag: string; when: number; hash: string }[], appliquees: { created_at: number; hash: string }[]): string[] {
  if (!appliquees.length) return [];
  const derniere = Math.max(...appliquees.map((a) => a.created_at));
  const hashs = new Set(appliquees.map((a) => a.hash));
  return entrees.filter((e) => e.when <= derniere && !hashs.has(e.hash)).map((e) => e.tag);
}

function roleDeLUrl(url: string): { role: string; parametres: string[]; hote: string; port: string } | undefined {
  try {
    const u = new URL(url);
    return { role: decodeURIComponent(u.username), parametres: [...u.searchParams.keys()], hote: u.hostname.toLowerCase(), port: u.port };
  } catch {
    return undefined;
  }
}

// `journal` est réservé aux essais (journal dans un schéma jetable) ; la production n'en passe jamais.
export async function migrer(options: { url: string; dossier: string; journal?: { schema: string; table: string } }): Promise<void> {
  const journal = options.journal ?? JOURNAL_PAR_DEFAUT;
  if (!NOM_JOURNAL.test(journal.schema) || !NOM_JOURNAL.test(journal.table)) throw new Error("migrer : nom de journal invalide (attendu ^[a-z0-9_]+$)");
  const lu = roleDeLUrl(options.url);
  if (lu?.role !== ROLE || lu.parametres.some((p) => p !== "sslmode")) {
    throw new Error(`migrer exige une URL du rôle ${ROLE}, sans autre paramètre que sslmode`);
  }
  // Le verrou de session serait faux derrière PgBouncer (mode transaction) : connexion directe seulement.
  if (lu && (lu.port === "6432" || lu.hote.includes("pgbouncer"))) throw new Error("migrer exige une connexion directe à PostgreSQL, pas PgBouncer (le verrou de session y serait faux)");
  // Même contrôle que la garde, sur exactement les fichiers que drizzle va appliquer, avant toute connexion.
  const refus = verifierDossier(options.dossier);
  if (refus.length) throw new Error(`migrations refusées :\n${refus.join("\n")}`);
  if (!existsSync(`${options.dossier}/meta/_journal.json`)) return; // dossier vide : rien à appliquer
  const client = new pg.Client({ connectionString: options.url });
  await client.connect();
  try {
    // Le rôle réel de la session fait foi, pas le nom écrit dans l'URL (current_user vaut le propriétaire après le SET ROLE par défaut).
    const { rows } = await client.query<{ role: string }>("SELECT session_user AS role");
    if (rows[0]?.role !== ROLE) throw new Error(`migrer exige le rôle ${ROLE}`);
    // La garde lit le SQL en UTF-8 avec standard_conforming_strings = on : le serveur doit le lire pareil.
    await client.query("SET standard_conforming_strings = on; SET client_encoding = 'UTF8'");
    await client.query("SELECT pg_advisory_lock($1)", [VERROU_MIGRATION.toString()]);
    try {
      await verifierDates(client, options.dossier, journal);
      await migrate(drizzle(client), { migrationsFolder: options.dossier, migrationsSchema: journal.schema, migrationsTable: journal.table });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [VERROU_MIGRATION.toString()]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

// Usage : MIGRATION_DATABASE_URL=… node apps/api/src/db/migrer.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env["MIGRATION_DATABASE_URL"] ?? "";
  migrer({ url, dossier: fileURLToPath(new URL("../../drizzle", import.meta.url)) }).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "migration impossible");
    process.exit(1);
  });
}

// Sous le verrou : refuse une migration insérée au milieu, que drizzle sauterait sans erreur.
async function verifierDates(client: pg.Client, dossier: string, journal: { schema: string; table: string }): Promise<void> {
  const table = `"${journal.schema}"."${journal.table}"`;
  const existe = await client.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [table]);
  if (!existe.rows[0]?.t) return;
  const { rows } = await client.query<{ created_at: string; hash: string }>(`SELECT created_at::text AS created_at, hash FROM ${table}`);
  const lu = JSON.parse(readFileSync(`${dossier}/meta/_journal.json`, "utf8")) as { entries: { tag: string; when: number }[] };
  const entrees = lu.entries.map((e) => ({ tag: e.tag, when: e.when, hash: createHash("sha256").update(readFileSync(`${dossier}/${e.tag}.sql`).toString()).digest("hex") }));
  const sautees = migrationsSautees(entrees, rows.map((r) => ({ created_at: Number(r.created_at), hash: r.hash })));
  if (sautees.length) throw new Error(`migrations refusées : ${sautees.join(", ")} porte une date sous celle de la dernière migration appliquée et serait sautée par drizzle (repartir de main et régénérer)`);
}
