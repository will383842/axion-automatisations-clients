import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const lire = (f: string) => readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)), "utf8");

// Section 3 de CLAUDE.md : « Consignes de routine » (jusqu'à la section 4).
const section3 = () => {
  const t = lire("CLAUDE.md");
  const debut = t.indexOf("## 3.");
  const fin = t.indexOf("## 4.");
  return t.slice(debut, fin);
};

describe("consigne de revérification des dépôts liés", () => {
  it("[A-023] CLAUDE.md demande de revérifier les dépôts liés sur main avant de coder", () => {
    const s = section3();
    expect(s).toMatch(/axion-ia/);
    expect(s).toMatch(/Axion-CRM-Pro/);
    expect(s).toMatch(/\bmain\b/);
    expect(s).toMatch(/avant de coder/i);
    expect(s).toMatch(/revérifier/i);
  });
});
