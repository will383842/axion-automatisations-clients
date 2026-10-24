import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyserFichier, verifierArbre } from "./garde-couleurs.ts";

describe("garde-couleurs", () => {
  it("[C-595] garde-couleurs refuse #1a4dd9 dans un composant", () => {
    const e = analyserFichier("apps/portail/Carte.tsx", `const s = { color: "#1a4dd9" };`);
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("Carte.tsx:1");
  });

  it("[C-595] garde-couleurs refuse rgb(, hsl( et les noms de couleur CSS", () => {
    expect(analyserFichier("a.css", "a { color: rgb(1, 2, 3); }")).toHaveLength(1);
    expect(analyserFichier("a.css", "a { background: hsl(10 20% 30%); }")).toHaveLength(1);
    expect(analyserFichier("a.css", "a { border-color: red; }")).toHaveLength(1);
  });

  it("[C-595] garde-couleurs accepte transparent, currentColor, inherit", () => {
    const css = "a { color: inherit; background: transparent; border-color: currentColor; }";
    expect(analyserFichier("a.css", css)).toEqual([]);
  });

  it("[C-595] garde-couleurs accepte var(--couleur-action)", () => {
    expect(analyserFichier("a.css", "a { color: var(--couleur-action); }")).toEqual([]);
  });

  it("[C-597] garde-couleurs refuse « POUR VOUS » et « POUR VOS CLIENTS »", () => {
    expect(analyserFichier("a.tsx", "<p>POUR VOUS (AXION IA)</p>")).toHaveLength(1);
    expect(analyserFichier("a.tsx", "<p>POUR VOS CLIENTS</p>")).toHaveLength(1);
  });

  it("[C-595] verifierArbre ignore jetons.ts, jetons.css, tests, fixtures et node_modules", () => {
    const r = mkdtempSync(join(tmpdir(), "gc-"));
    for (const d of ["apps/x/src", "packages/design/src", "packages/y/__fixtures__", "packages/y/node_modules/z"]) {
      mkdirSync(join(r, d), { recursive: true });
    }
    const rouge = `const c = "#c24a1b";`;
    writeFileSync(join(r, "packages/design/src/jetons.ts"), rouge);
    writeFileSync(join(r, "packages/design/src/jetons.css"), "a { color: #c24a1b; }");
    writeFileSync(join(r, "apps/x/src/a.test.ts"), rouge);
    writeFileSync(join(r, "packages/y/__fixtures__/f.ts"), rouge);
    writeFileSync(join(r, "packages/y/node_modules/z/i.js"), rouge);
    expect(verifierArbre(r)).toEqual([]);
    writeFileSync(join(r, "apps/x/src/mauvais.ts"), rouge);
    expect(verifierArbre(r)).toHaveLength(1);
  });
});
