import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formaterTrouvailles, scannerDepot } from "./garde-donnees-reelles.js";

// Les « mauvais exemples » sont fabriqués ici, à l'exécution : jamais écrits en clair.
const arobase = "@";
const courrielReel = ["jean.dupont", ["societe", "fr"].join(".")].join(arobase);
const hoteInsee = ["api", "insee", "fr"].join(".");
const hoteRecherche = ["recherche-entreprises", "api", "gouv", "fr"].join(".");
const racine = mkdtempSync(join(tmpdir(), "garde-donnees-"));
afterAll(() => rmSync(racine, { recursive: true, force: true }));

function ecrire(chemin: string, contenu: string): string {
  const complet = join(racine, chemin);
  mkdirSync(dirname(complet), { recursive: true });
  writeFileSync(complet, contenu);
  return chemin;
}

describe("garde-donnees-reelles", () => {
  it("[C-532] garde-donnees-reelles refuse un fichier StockUniteLegale", () => {
    const f = ecrire("donnees/" + ["Stock", "UniteLegale", "utf8.csv"].join(""), "x\n");
    const g = ecrire("donnees/autre.csv", ["siren", "denomination"].join(";") + "\n123;abc\n");
    const h = ecrire("donnees/lot.parquet", "x");
    const t = scannerDepot(racine, [f, g, h]);
    expect(t.map((x) => x.fichier)).toEqual([f, g, h]);
    expect(t.every((x) => x.type === "extrait Sirene")).toBe(true);
  });
  it("[C-532] garde-donnees-reelles refuse un extrait à en-tête séparé par des virgules", () => {
    const f = ecrire("donnees/a.csv", ["siren", "statutDiffusionUniteLegale"].join(",") + "\n123,O\n");
    const g = ecrire("donnees/b.csv", ["siren", "nom"].join("\t") + "\n123\tx\n");
    const h = ecrire("donnees/c.csv", ["nom", "siret", "ville"].join(",") + "\nx,1,y\n");
    const t = scannerDepot(racine, [f, g, h]);
    expect(t.map((x) => x.fichier)).toEqual([f, g, h]);
  });
  it("[C-532] garde-donnees-reelles refuse un fichier volumineux ou une archive dans le dossier des mauvais exemples", () => {
    const f = ecrire("scripts/__fixtures__/donnees-reelles/gros.csv", "x".repeat(10000));
    const g = ecrire("scripts/__fixtures__/donnees-reelles/lot.zip", "x");
    const t = scannerDepot(racine, [f, g]);
    expect(t.map((x) => x.fichier)).toEqual([f, g]);
  });
  it("[C-378] garde-donnees-reelles étend le périmètre aux tests spec, tsx et e2e", () => {
    const fichiers = ["apps/api/src/a.spec.ts", "apps/portail/src/b.test.tsx", "tests/e2e/c.json", "apps/api/fixture/d.json"].map((c) => ecrire(c, `"${courrielReel}"\n`));
    expect(scannerDepot(racine, fichiers).map((x) => x.fichier)).toEqual(fichiers);
  });
  it("[C-390] garde-donnees-reelles refuse les autres API et fichiers de registre public", () => {
    const hotes = [["entreprise", "api", "gouv", "fr"], ["files", "data", "gouv", "fr"], ["registre-national-entreprises", "inpi", "fr"]].map((h) => h.join("."));
    const fichiers = hotes.map((h, i) => ecrire(`apps/api/src/r${i}.test.ts`, `"https://${h}/x"\n`));
    expect(scannerDepot(racine, fichiers).map((x) => x.fichier)).toEqual(fichiers);
  });
  it("[C-390] garde-donnees-reelles refuse l'adresse d'une API de registre public dans un test", () => {
    const f = ecrire("apps/api/src/x.test.ts", `const a = 1;\nfetch("https://${hoteInsee}/entreprises");\n`);
    const g = ecrire("packages/harnais/src/y.ts", `const u = "https://${hoteRecherche}/search";\n`);
    const t = scannerDepot(racine, [f, g]);
    expect(t).toEqual([
      { type: "registre public", fichier: f, ligne: 2 },
      { type: "registre public", fichier: g, ligne: 1 },
    ]);
  });
  it("[C-378] garde-donnees-reelles refuse un e-mail réel dans une fixture sans afficher l'adresse", () => {
    const f = ecrire("apps/api/fixtures/a.json", `{\n "contact": "${courrielReel}"\n}\n`);
    const t = scannerDepot(racine, [f]);
    expect(t).toEqual([{ type: "e-mail", fichier: f, ligne: 2 }]);
    const sortie = formaterTrouvailles(t).join("\n");
    expect(sortie).toBe(`e-mail, ${f}, ligne 2`);
    expect(sortie).not.toContain("dupont");
  });
  it("[C-378] garde-donnees-reelles laisse passer les e-mails fictifs et les fichiers hors périmètre", () => {
    const f = ecrire("apps/api/fixtures/b.json", ["a", "exemple.fr"].join(arobase) + "\n" + ["b", "client.test"].join(arobase) + "\n");
    const g = ecrire("apps/api/src/code.ts", `const x = "${courrielReel}";\n`);
    const h = ecrire("scripts/__fixtures__/donnees-reelles/mauvais.csv", ["siren", "nom"].join(";") + "\n");
    expect(scannerDepot(racine, [f, g, h])).toEqual([]);
  });
});
