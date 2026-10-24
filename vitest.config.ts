import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Racine du dépôt figée : Vitest ne remonte jamais chercher une configuration dans un dossier parent.
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
});
