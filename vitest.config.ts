import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// retry: 0 — aucune relance automatique (C-538), pour chaque projet.
const retry = 0;
// Vitest 4 a retiré **/dist/** de ses exclusions par défaut : on le remet.
// tests/visuel.spec.ts est un test Playwright (workflow visuel-design.yml), pas un test Vitest.
const exclude = [...configDefaults.exclude, "**/dist/**", "**/__fixtures__/**", "**/tests/visuel.spec.ts"];
// Les tests d'intégration demandent le socle lancé (ops/socle/lancer.sh) : seul le projet integration les prend.
const excludeDefaut = [...exclude, "**/*.int.test.ts"];
// Tests qui modifient le dépôt : projet « serie », lancé seul après les autres (groupOrder), jamais en parallèle de la garde qui le parcourt.
const serie = "**/*-bin.test.ts";
const integration = process.env.SOCLE_INTEGRATION === "1";
const dossiers = (racine: string) =>
  readdirSync(racine, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${racine}/${d.name}/package.json`))
    .map((d) => `${racine}/${d.name}`)
    .sort();

// Racine du dépôt figée : Vitest ne remonte jamais chercher une configuration dans un dossier parent.
// Vitest 4 ne lit plus vitest.workspace.ts : les projets sont déclarés ici, dans test.projects.
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: {
    projects: [
      { test: { name: "scripts", root: "./scripts", retry, exclude: excludeDefaut } },
      ...[...dossiers("apps"), ...dossiers("packages"), ...(existsSync("modules") ? dossiers("modules") : [])].map((d) => ({ test: { name: d, root: `./${d}`, retry, exclude: [...excludeDefaut, serie] } })),
      { test: { name: "serie", root: ".", retry, exclude: excludeDefaut, include: [`packages/*/src/${serie.slice(3)}`], fileParallelism: false, sequence: { groupOrder: 1 } } },
      // Tests de l'exploitation (ops/), lancés par la CI comme les autres.
      { test: { name: "ops", root: "./ops", retry, exclude: excludeDefaut } },
      // Scénarios de bout en bout rouges au départ (ADR 0005, T0-21).
      { test: { name: "tests/e2e", root: "./tests/e2e", retry, exclude: excludeDefaut } },
      // Bouchons du Hub et du CRM (T2-13) ; leurs suites .int.test.ts passent par le projet integration.
      { test: { name: "tests/bouchons", root: "./tests/bouchons", retry, exclude: excludeDefaut } },
      { test: { name: "tests/comportement", root: "./tests/comportement", retry, exclude: excludeDefaut, passWithNoTests: true } },
      // Vide sans SOCLE_INTEGRATION=1, pour que « vitest run » ne lance jamais ces tests faute de services.
      { test: { name: "integration", root: ".", retry, exclude, include: integration ? ["**/*.int.test.ts"] : [] } },
    ],
  },
});
