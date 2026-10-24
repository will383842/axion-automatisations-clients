import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import espaces from "../vitest.workspace.js";

describe("vitest.workspace", () => {
  it("[C-538] chaque dossier de apps/ et packages/ avec un package.json est un projet, sans relance", () => {
    const attendus = ["apps", "packages"].flatMap((r) =>
      readdirSync(r, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(`${r}/${d.name}/package.json`))
        .map((d) => `${r}/${d.name}`),
    );
    const noms = espaces.map((e) => e.test.name);
    for (const a of attendus) expect(noms).toContain(a);
    for (const e of espaces) expect(e.test.retry).toBe(0);
  });
  it("[C-538] les exclusions par défaut de Vitest sont conservées", () => {
    for (const e of espaces) expect(e.test.exclude).toContain("**/dist/**");
  });
});
