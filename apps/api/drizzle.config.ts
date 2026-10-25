import { defineConfig } from "drizzle-kit";

// Génération seulement (pnpm exec drizzle-kit generate) ; l'application des migrations passe par src/db/migrer.ts.
export default defineConfig({ dialect: "postgresql", out: "./drizzle", schema: "./src/db/schema.ts" });
