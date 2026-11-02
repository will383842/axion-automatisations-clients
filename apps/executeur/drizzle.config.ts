import { defineConfig } from "drizzle-kit";

// Génération seulement (pnpm exec drizzle-kit generate) ; l'application des migrations est faite avec moteur_migration, jamais moteur_app.
export default defineConfig({ dialect: "postgresql", out: "./drizzle", schema: "./src/db/schema.ts" });
