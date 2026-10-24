import { existsSync, readdirSync } from "node:fs";
import { configDefaults } from "vitest/config";

// retry: 0 — aucune relance automatique (C-538), pour chaque projet.
const retry = 0;
// Vitest 4 n'exclut plus « dist » par défaut : on le garde explicitement.
const exclude = [...configDefaults.exclude, "**/dist/**", "**/__fixtures__/**"];
const dossiers = (racine: string) =>
  readdirSync(racine, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${racine}/${d.name}/package.json`))
    .map((d) => `${racine}/${d.name}`)
    .sort();

export default [
  { test: { name: "scripts", root: "./scripts", retry, exclude } },
  ...[...dossiers("apps"), ...dossiers("packages")].map((d) => ({ test: { name: d, root: `./${d}`, retry, exclude } })),
];
