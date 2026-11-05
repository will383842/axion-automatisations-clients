import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agregerPreuves, consommateursDirects, fichierPreuvesDeBranche, verifierDossierPreuves } from "./agreger-preuves.js";
import { doublonsPreuves, validerReqIds, verifierCouverture } from "./couverture-req.js";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), "utf8");
const git = (dossier: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@exemple.fr", ...args], { cwd: dossier, encoding: "utf8" });

// Dépôt jetable : base commune puis deux branches factices, chacune avec son changement.
function deuxBranches(changer: (d: string, branche: string) => void) {
  const d = mkdtempSync(join(tmpdir(), "preuves-"));
  git(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, "spec/preuves"), { recursive: true });
  writeFileSync(join(d, "spec/preuves.md"), "A-001 → preuve historique\n");
  writeFileSync(join(d, "spec/preuves/README.md"), "dossier\n");
  git(d, "add", ".");
  git(d, "commit", "-qm", "base");
  for (const b of ["lot-9/fiche-un", "lot-9/fiche-deux"]) {
    git(d, "checkout", "-qb", b, "main");
    changer(d, b);
    git(d, "add", ".");
    git(d, "commit", "-qm", b);
  }
  // Calcul de GitHub : fusion à trois sans pilote de fusion local (pas de .gitattributes dans ce dépôt).
  return spawnSync("git", ["merge-tree", "--write-tree", "lot-9/fiche-un", "lot-9/fiche-deux"], { cwd: d, encoding: "utf8" });
}

// Entrées « <numéro> → … » : exigences couvertes et dettes.
const entrees = (texte: string) => [...texte.matchAll(/^(\S+)\s*→.*$/gm)].map((m) => m[0]);
const numeros = (texte: string) => entrees(texte).map((l) => l.split(/\s*→/)[0] ?? "");

describe("preuves : un fichier par fiche (ADR 0029, mise à jour)", () => {
  it("[ADR-preuves] deux PR qui ajoutent chacune un fichier sous spec/preuves/ ne se conflictent pas (git merge-tree sur deux branches factices)", () => {
    const sansConflit = deuxBranches((d, b) => writeFileSync(join(d, fichierPreuvesDeBranche(b)), `C-555 → preuve de ${b}\n`));
    expect(sansConflit.status, sansConflit.stdout).toBe(0);
    // Témoin : l'ancienne façon (ajout en fin de spec/preuves.md) est en conflit pour GitHub.
    const ancien = deuxBranches((d, b) => appendFileSync(join(d, "spec/preuves.md"), `C-555 → preuve de ${b}\n`));
    expect(ancien.status).toBe(1);
    expect(ancien.stdout).toContain("CONFLICT");
  });

  it("[ADR-preuves] le nom du fichier vient de la branche assainie", () => {
    expect(fichierPreuvesDeBranche("lot-0/preuves-par-fiche")).toBe("spec/preuves/lot-0-preuves-par-fiche.md");
    expect(fichierPreuvesDeBranche("Lot-2/T2-37b")).toBe("spec/preuves/lot-2-t2-37b.md");
    expect(fichierPreuvesDeBranche("claude/a b/../c")).toBe("spec/preuves/claude-a-b-c.md");
    expect(() => fichierPreuvesDeBranche("///")).toThrow();
  });

  it("[ADR-preuves] l'agrégat met l'historique d'abord, puis les fichiers dans l'ordre des noms, sans le README", () => {
    const d = mkdtempSync(join(tmpdir(), "agregat-"));
    mkdirSync(join(d, "spec/preuves"), { recursive: true });
    writeFileSync(join(d, "spec/preuves.md"), "A-001 → historique");
    writeFileSync(join(d, "spec/preuves/lot-2-b.md"), "A-003 → b\n");
    writeFileSync(join(d, "spec/preuves/lot-1-a.md"), "A-002 → a\n\n");
    writeFileSync(join(d, "spec/preuves/README.md"), "C-999 → ne compte pas\n");
    expect(agregerPreuves(d)).toBe("A-001 → historique\nA-002 → a\nA-003 → b\n");
    expect(agregerPreuves(d)).toBe(agregerPreuves(d));
    const vide = mkdtempSync(join(tmpdir(), "agregat-"));
    expect(agregerPreuves(vide)).toBe("");
  });

  it("[ADR-preuves] un numéro présent dans l'historique et dans un fichier est refusé comme doublon", () => {
    const d = mkdtempSync(join(tmpdir(), "agregat-"));
    mkdirSync(join(d, "spec/preuves"), { recursive: true });
    writeFileSync(join(d, "spec/preuves.md"), "C-392 → historique\n");
    writeFileSync(join(d, "spec/preuves/lot-1-a.md"), "C-392 → encore\n");
    expect(doublonsPreuves(agregerPreuves(d))).toEqual(["C-392 : présent deux fois dans spec/preuves.md"]);
    writeFileSync(join(d, "spec/preuves/lot-1-a.md"), "C-392 (suite) → complément\n");
    expect(doublonsPreuves(agregerPreuves(d))).toEqual([]);
  });

  it("[ADR-preuves] un nom de fichier non assaini sous spec/preuves/ est signalé", () => {
    const d = mkdtempSync(join(tmpdir(), "agregat-"));
    mkdirSync(join(d, "spec/preuves"), { recursive: true });
    writeFileSync(join(d, "spec/preuves/lot-1-a.md"), "A-002 → a\n");
    writeFileSync(join(d, "spec/preuves/README.md"), "x\n");
    expect(verifierDossierPreuves(d)).toEqual([]);
    writeFileSync(join(d, "spec/preuves/Lot 1.md"), "A-002 → a\n");
    writeFileSync(join(d, "spec/preuves/lot-1-b.txt"), "A-004 → b\n");
    expect(verifierDossierPreuves(d)).toEqual(["spec/preuves/Lot 1.md : nom non assaini", "spec/preuves/lot-1-b.txt : nom non assaini"]);
    expect(verifierDossierPreuves(RACINE)).toEqual([]);
  });

  it("[ADR-preuves] non-régression : l'agrégat de l'historique seul donne les mêmes exigences couvertes et les mêmes dettes que spec/preuves.md", () => {
    const historique = lire("spec/preuves.md");
    const d = mkdtempSync(join(tmpdir(), "agregat-"));
    mkdirSync(join(d, "spec/preuves"), { recursive: true });
    copyFileSync(join(RACINE, "spec/preuves.md"), join(d, "spec/preuves.md"));
    copyFileSync(join(RACINE, "spec/preuves/README.md"), join(d, "spec/preuves/README.md"));
    const agregat = agregerPreuves(d);
    expect(numeros(agregat)).toEqual(numeros(historique));
    expect(entrees(agregat).filter((l) => l.includes("dette"))).toEqual(entrees(historique).filter((l) => l.includes("dette")));
    expect(doublonsPreuves(agregat)).toEqual(doublonsPreuves(historique));
    const reqs = validerReqIds(JSON.parse(lire("spec/req-ids.json")), JSON.parse(lire("spec/req-ids.schema.json")));
    const documents = reqs.filter((r) => /document|exercice|mesure/.test(r.preuve));
    expect(documents.length).toBeGreaterThan(0);
    for (const r of documents) {
      const corps = `Exigences : ${r.id}`;
      const avec = (preuves: string) => verifierCouverture({ reqs: [r], corps, tests: [{ nom: `[${r.id}] t`, passe: true }], preuves });
      expect(avec(agregat), r.id).toEqual(avec(historique));
    }
    // L'agrégat réel garde chaque ligne historique, dans le même ordre, en tête.
    expect(agregerPreuves(RACINE).startsWith(historique.trimEnd())).toBe(true);
  });

  it("[ADR-preuves] aucun consommateur ne lit encore spec/preuves.md directement (tous passent par agregerPreuves)", () => {
    expect(consommateursDirects('const p = readFileSync("spec/preuves.md", "utf8");')).toHaveLength(1);
    expect(consommateursDirects('const p = lire("../../../../../spec/preuves.md");')).toHaveLength(1);
    expect(consommateursDirects('new URL("../spec/preuves.md", import.meta.url)')).toHaveLength(1);
    expect(consommateursDirects("grep -n C-392 spec/preuves.md")).toHaveLength(1);
    expect(consommateursDirects('trouves.push("spec/preuves.md");')).toEqual([]);
    expect(consommateursDirects('// voir `spec/preuves.md`\nwriteFileSync(join(d, "spec/preuves.md"), "x");')).toEqual([]);
    const fichiers: string[] = [];
    const parcourir = (dossier: string) => {
      for (const e of readdirSync(dossier, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git", "__fixtures__"].includes(e.name)) continue;
        const chemin = join(dossier, e.name);
        if (e.isDirectory()) parcourir(chemin);
        else if (/\.(ts|tsx|js|mjs|cjs|sh)$/.test(e.name)) fichiers.push(chemin);
      }
    };
    for (const racine of ["scripts", "apps", "packages", "tests", "ops"]) parcourir(join(RACINE, racine));
    const fautifs = fichiers
      .filter((f) => !/scripts\/agreger-preuves(\.test)?\.ts$/.test(f))
      .flatMap((f) => consommateursDirects(readFileSync(f, "utf8")).map((l) => `${relative(RACINE, f)} : ${l}`));
    expect(fautifs).toEqual([]);
  });
});
