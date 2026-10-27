import { existsSync } from "node:fs";
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

function roleDeLUrl(url: string): { role: string; parametres: string[] } | undefined {
  try {
    const u = new URL(url);
    return { role: decodeURIComponent(u.username), parametres: [...u.searchParams.keys()] };
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
