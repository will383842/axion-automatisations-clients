import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

// Projets lus dans vitest.config.ts : le seul fichier que Vitest 4 charge réellement.
const projets = (config.test?.projects ?? []) as { test: { name: string; retry: number; exclude: string[] } }[];

describe("vitest.config projets", () => {
  it("[C-538] chaque dossier de apps/ et packages/ avec un package.json est un projet, sans relance", () => {
    const attendus = ["apps", "packages"].flatMap((r) =>
      readdirSync(r, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(`${r}/${d.name}/package.json`))
        .map((d) => `${r}/${d.name}`),
    );
    const noms = projets.map((p) => p.test.name);
    for (const a of attendus) expect(noms).toContain(a);
    for (const p of projets) expect(p.test.retry).toBe(0);
  });
  it("[C-538] les exclusions par défaut de Vitest sont conservées", () => {
    expect(projets.length).toBeGreaterThan(0);
    for (const p of projets) expect(p.test.exclude).toContain("**/dist/**");
  });
  it("[C-538] Vitest accepte --project scripts (la configuration est bien lue)", () => {
    const r = spawnSync("npx", ["vitest", "list", "--filesOnly", "--project", "scripts"], { encoding: "utf8" });
    expect(r.stderr).not.toContain("No projects matched");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("vitest-projets.test.ts");
  });
});
