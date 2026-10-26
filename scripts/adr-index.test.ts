import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifierCouverture } from "./couverture-req.js";
import { genererIndex, lireAdr, verifierAdr, verifierDepot, type Adr } from "./adr-index.js";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), "utf8");

const adr = (nom: string, titre: string): Adr => ({ fichier: nom, ...lireAdr(nom, titre)! });

describe("index des ADR généré", () => {
  it("[zero-conflit] lit les deux formes de titre et refuse un titre illisible", () => {
    expect(lireAdr("0001-a.md", "# 0001 · Garde des noms")).toEqual({ numero: "0001", titre: "Garde des noms" });
    expect(lireAdr("0015-b.md", "# ADR 0015 — Stockage S3")).toEqual({ numero: "0015", titre: "Stockage S3" });
    expect(lireAdr("0002-c.md", "Pas un titre")).toBeNull();
  });

  it("[zero-conflit] l'index est trié par numéro, une ligne par ADR", () => {
    const index = genererIndex([adr("0021-b.md", "# 0021 · Deux"), adr("0003-a.md", "# 0003 · Un")]);
    expect(index).toContain("| 0003 | Un |");
    expect(index.indexOf("| 0003 |")).toBeLessThan(index.indexOf("| 0021 |"));
  });

  it("[zero-conflit] deux ADR de même numéro sont refusés", () => {
    const erreurs = verifierAdr([adr("0029-a.md", "# 0029 · A"), adr("0029-b.md", "# 0029 · B")]);
    expect(erreurs.join("\n")).toMatch(/0029.*0029-a\.md.*0029-b\.md/);
  });

  it("[zero-conflit] le numéro du nom de fichier doit être celui du titre", () => {
    expect(verifierAdr([adr("0030-a.md", "# 0031 · A")]).join("\n")).toMatch(/0030-a\.md/);
  });

  it("[zero-conflit] le dépôt n'a aucun doublon et son index écrit (s'il existe) est à jour", () => {
    expect(verifierDepot(RACINE)).toEqual([]);
  });

  it("[zero-conflit] un index écrit périmé est refusé", () => {
    const dossier = mkdtempSync(join(tmpdir(), "adr-"));
    mkdirSync(join(dossier, "docs/adr"), { recursive: true });
    writeFileSync(join(dossier, "docs/adr/0001-a.md"), "# 0001 · A\n");
    writeFileSync(join(dossier, "docs/adr/index.md"), "vieux\n");
    expect(verifierDepot(dossier).join("\n")).toMatch(/périmé/);
  });

  it("[zero-conflit] le README des ADR n'est plus une liste à la main", () => {
    expect(lire("docs/adr/README.md")).not.toMatch(/^\| 0\d{3} \|/m);
  });
});

describe("fusion de deux branches : fichiers ajoutés ligne à ligne", () => {
  const git = (dossier: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@exemple.fr", ...args], { cwd: dossier, encoding: "utf8" });

  it("[zero-conflit] .gitattributes déclare merge=union seulement pour spec/preuves.md", () => {
    const attr = lire(".gitattributes");
    expect(attr).toMatch(/^spec\/preuves\.md\s+merge=union$/m);
    expect(attr.match(/merge=union/g)).toHaveLength(1);
    expect(attr).not.toMatch(/pnpm-lock|\.json.*merge=union/);
  });

  it("[zero-conflit] deux branches qui ajoutent des lignes à la fin fusionnent sans conflit ni doublon", () => {
    const d = mkdtempSync(join(tmpdir(), "fusion-"));
    git(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, ".gitattributes"), lire(".gitattributes"));
    mkdirSync(join(d, "spec"));
    writeFileSync(join(d, "spec/preuves.md"), "A-001 → preuve de départ\n");
    git(d, "add", "."); git(d, "commit", "-qm", "base");
    for (const [branche, ligne] of [["b1", "A-002 → preuve un"], ["b2", "A-003 → preuve deux"]] as const) {
      git(d, "checkout", "-qb", branche, "main");
      appendFileSync(join(d, "spec/preuves.md"), `${ligne}\n`);
      git(d, "commit", "-qam", branche);
    }
    git(d, "checkout", "-q", "b1");
    git(d, "merge", "-q", "--no-edit", "b2");
    const lignes = readFileSync(join(d, "spec/preuves.md"), "utf8").trim().split("\n");
    expect(lignes.sort()).toEqual(["A-001 → preuve de départ", "A-002 → preuve un", "A-003 → preuve deux"]);
  });

  it("[zero-conflit] la même ligne ajoutée des deux côtés n'est pas dupliquée", () => {
    const d = mkdtempSync(join(tmpdir(), "fusion-"));
    git(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, ".gitattributes"), lire(".gitattributes"));
    mkdirSync(join(d, "spec"));
    writeFileSync(join(d, "spec/preuves.md"), "A-001 → départ\n");
    git(d, "add", "."); git(d, "commit", "-qm", "base");
    for (const b of ["b1", "b2"]) {
      git(d, "checkout", "-qb", b, "main");
      appendFileSync(join(d, "spec/preuves.md"), "A-002 → commune\n");
      git(d, "commit", "-qam", b);
    }
    git(d, "checkout", "-q", "b1");
    git(d, "merge", "-q", "--no-edit", "b2");
    expect(readFileSync(join(d, "spec/preuves.md"), "utf8").match(/A-002/g)).toHaveLength(1);
  });

  it("[zero-conflit] deux branches qui prouvent le même numéro avec des textes différents : la fusion passe, la garde refuse", () => {
    const d = mkdtempSync(join(tmpdir(), "fusion-"));
    git(d, "init", "-q", "-b", "main");
    writeFileSync(join(d, ".gitattributes"), lire(".gitattributes"));
    mkdirSync(join(d, "spec"));
    writeFileSync(join(d, "spec/preuves.md"), "C-392 → départ\n");
    git(d, "add", "."); git(d, "commit", "-qm", "base");
    for (const [b, texte] of [["b1", "preuve un"], ["b2", "preuve deux"]] as const) {
      git(d, "checkout", "-qb", b, "main");
      appendFileSync(join(d, "spec/preuves.md"), `C-555 → ${texte}\n`);
      git(d, "commit", "-qam", b);
    }
    git(d, "checkout", "-q", "b1");
    git(d, "merge", "-q", "--no-edit", "b2");
    const preuves = readFileSync(join(d, "spec/preuves.md"), "utf8");
    expect(preuves.match(/^C-555/gm)).toHaveLength(2);
    const r = verifierCouverture({ reqs: [], corps: "Exigences : aucune (outillage)", tests: [], preuves });
    expect(r.erreurs.join("\n")).toContain("C-555 : présent deux fois");
  });

  it("[zero-conflit] un fichier de docs/adr/ au nom non conforme est signalé", () => {
    const d = mkdtempSync(join(tmpdir(), "adr-"));
    mkdirSync(join(d, "docs/adr"), { recursive: true });
    writeFileSync(join(d, "docs/adr/0021-a.md"), "# 0021 · A\n");
    writeFileSync(join(d, "docs/adr/README.md"), "x\n");
    expect(verifierDepot(d)).toEqual([]);
    writeFileSync(join(d, "docs/adr/0021_b.md"), "# 0021 · B\n");
    writeFileSync(join(d, "docs/adr/030-a.md"), "# 0030 · C\n");
    const e = verifierDepot(d).join("\n");
    expect(e).toContain("0021_b.md : nom non conforme");
    expect(e).toContain("030-a.md : nom non conforme");
  });

  it("[zero-conflit] deux ADR ajoutés par deux branches fusionnent sans toucher un fichier commun", () => {
    const d = mkdtempSync(join(tmpdir(), "fusion-"));
    git(d, "init", "-q", "-b", "main");
    mkdirSync(join(d, "docs/adr"), { recursive: true });
    writeFileSync(join(d, "docs/adr/README.md"), lire("docs/adr/README.md"));
    git(d, "add", "."); git(d, "commit", "-qm", "base");
    for (const [b, n] of [["b1", "0030"], ["b2", "0031"]] as const) {
      git(d, "checkout", "-qb", b, "main");
      writeFileSync(join(d, `docs/adr/${n}-x.md`), `# ${n} · Titre ${n}\n`);
      git(d, "add", "."); git(d, "commit", "-qm", b);
    }
    git(d, "checkout", "-q", "b1");
    git(d, "merge", "-q", "--no-edit", "b2");
    expect(verifierDepot(d)).toEqual([]);
  });
});

describe("règle de contribution", () => {
  it("[zero-conflit] le README demande de fusionner main avant d'ouvrir la PR et avant la relecture", () => {
    expect(lire("README.md")).toMatch(/fusionn\w+ `main`[^\n]*avant d'ouvrir la PR[^\n]*avant de demander la relecture/i);
  });
});
