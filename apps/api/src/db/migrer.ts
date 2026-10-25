import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// Outil de migration : applique apps/api/drizzle/ avec console_migration, jamais console_app.
// Le journal des migrations appliquées est la table drizzle.__drizzle_migrations.
const ROLE = "console_migration";

function roleDeLUrl(url: string): { role: string; parametres: string[] } | undefined {
  try {
    const u = new URL(url);
    return { role: decodeURIComponent(u.username), parametres: [...u.searchParams.keys()] };
  } catch {
    return undefined;
  }
}

export async function migrer(options: { url: string; dossier: string }): Promise<void> {
  const lu = roleDeLUrl(options.url);
  if (lu?.role !== ROLE || lu.parametres.some((p) => p !== "sslmode")) {
    throw new Error(`migrer exige une URL du rôle ${ROLE}, sans autre paramètre que sslmode`);
  }
  if (!existsSync(`${options.dossier}/meta/_journal.json`)) return; // dossier vide : rien à appliquer
  const client = new pg.Client({ connectionString: options.url });
  await client.connect();
  try {
    // Le rôle réel de la session fait foi, pas le nom écrit dans l'URL (current_user vaut le propriétaire après le SET ROLE par défaut).
    const { rows } = await client.query<{ role: string }>("SELECT session_user AS role");
    if (rows[0]?.role !== ROLE) throw new Error(`migrer exige le rôle ${ROLE}`);
    await migrate(drizzle(client), { migrationsFolder: options.dossier });
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
