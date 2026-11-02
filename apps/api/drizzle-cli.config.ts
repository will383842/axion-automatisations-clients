import { defineConfig } from "drizzle-kit";

// Génération seulement (pnpm exec drizzle-kit generate --config drizzle-cli.config.ts) : le modèle des bases des clients, séparé du schéma de la console.
// L'application passe par src/donnees/migrer-base.ts. Les schémas a_<code> ne sont pas ici : ils viennent des migrations des modules (T2-35).
export default defineConfig({ dialect: "postgresql", out: "./drizzle-cli", schema: "./src/db/schema-cli/index.ts" });
