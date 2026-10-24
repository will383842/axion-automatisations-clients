import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parserListe, verifierDiff } from "./chercher.js";

// Nom inventé DES TESTS : il n'est dans aucune vraie liste.
const NOM = "Quincaillerie Zéphyrine Ostrowska";
const liste = parserListe(`${NOM} SARL`);
const racine = fileURLToPath(new URL("../..", import.meta.url));
const chercherTs = join(racine, "scripts/garde-noms/chercher.ts");
const depot = mkdtempSync(join(tmpdir(), "garde-diff-"));
afterAll(() => rmSync(depot, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({ PATH: process.env["PATH"] ?? "", HOME: depot, ...extra });
const lancer = (args: string[], entree: Buffer | string, extra: Record<string, string> = {}) =>
  spawnSync("node", [chercherTs, ...args], { cwd: depot, input: entree, env: env({ NOMS_CLIENTS: NOM, ...extra }) });
const sortie = (r: ReturnType<typeof lancer>) => `${r.stdout.toString("utf8")}${r.stderr.toString("utf8")}`;

const fichier = (chemin: string, ...ajoutees: string[]) =>
  `diff --git a/${chemin} b/${chemin}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${chemin}\n@@ -0,0 +1,${ajoutees.length} @@\n${ajoutees.map((l) => `+${l}`).join("\n")}\n`;

describe("verifierDiff", () => {
  it("[C-611] verifierDiff trouve le nom dans une ligne ajoutée", () => {
    const e = verifierDiff(fichier("a.md", "propre", `voici ${NOM}`), liste);
    expect(e).toEqual(["nom interdit, fichier a.md, ligne 2 (n° 1)"]);
  });
  it("[C-611] verifierDiff trouve le nom dans un chemin renommé (ancien et nouveau)", () => {
    const ancien = "diff --git a/docs/quincaillerie-zephyrine-ostrowska.md b/docs/autre.md\nsimilarity index 100%\nrename from docs/quincaillerie-zephyrine-ostrowska.md\nrename to docs/autre.md\n";
    const nouveau = "diff --git a/docs/autre.md b/docs/quincaillerie-zephyrine-ostrowska.md\nsimilarity index 100%\nrename from docs/autre.md\nrename to docs/quincaillerie-zephyrine-ostrowska.md\n";
    expect(verifierDiff(ancien, liste)).toEqual(["nom de fichier interdit (n° 1)"]);
    expect(verifierDiff(nouveau, liste)).toEqual(["nom de fichier interdit (n° 1)"]);
  });
  it("[C-611] verifierDiff trouve le nom coupé sur 2 lignes ajoutées", () => {
    const e = verifierDiff(fichier("a.md", "Atelier Bertin, puis Quincaillerie Zéphyrine", "Ostrowska et la suite"), liste);
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("ligne 2");
  });
  it("[C-611] verifierDiff ignore les lignes retirées", () => {
    const diff = `diff --git a/a.md b/a.md\nindex 1..2 100644\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1 @@\n-${NOM}\n---${NOM}\n+propre\n`;
    expect(verifierDiff(diff, liste)).toEqual([]);
  });
  it("[C-611] verifierDiff ignore un « +++ » de contenu après « @@ » mais lit son texte", () => {
    const e = verifierDiff(fichier("c.md", `++ ${NOM}`), liste);
    expect(e).toEqual(["nom interdit, fichier c.md, ligne 1 (n° 1)"]);
  });
  it("[C-611] verifierDiff trouve le nom accentué dans un nom de fichier", () => {
    const e = verifierDiff(fichier("docs/Quincaillerie-Zéphyrine-Ostrowska.md", "propre"), liste);
    expect(e).toEqual(["nom de fichier interdit (n° 1)"]);
  });
  it("[C-611] verifierDiff refuse un chemin échappé \\303\\251", () => {
    const diff = 'diff --git "a/docs/z\\303\\251.md" "b/docs/z\\303\\251.md"\nnew file mode 100644\n';
    expect(() => verifierDiff(diff, liste)).toThrow(/chemin échappé, relancer avec core.quotePath=false/);
  });
  it("[C-611] le mode diff sort 1 (refus) sur un chemin échappé sans nom, 2 si un nom est aussi présent", () => {
    const sansNom = 'diff --git "a/docs/z\\303\\251.md" "b/docs/z\\303\\251.md"\nnew file mode 100644\n';
    expect(lancer(["diff", "d"], sansNom).status).toBe(1);
    expect(lancer(["diff", "d"], 'diff --git "a/docs/\\001.md" "b/docs/\\001.md"\nnew file mode 100644\n').status).toBe(1);
    expect(lancer(["diff", "d"], sansNom + fichier("a.md", NOM)).status).toBe(2);
  });
  it("[C-611] verifierDiff refuse un \\3xx dans rename, --- ou +++ et dans un seul côté entre guillemets", () => {
    const rename = 'diff --git a/p1.md "b/z\\303\\251.md"\nsimilarity index 100%\nrename from p1.md\nrename to "z\\303\\251.md"\n';
    expect(() => verifierDiff(rename, liste)).toThrow(/chemin échappé/);
    const entetes = 'diff --git a/p1.md b/p1.md\nindex 1..2 100644\n--- "a/z\\303\\251.md"\n+++ b/p1.md\n';
    expect(() => verifierDiff(entetes, liste)).toThrow(/chemin échappé/);
  });
  it("[C-611] pre-commit contrôle aussi les changements de type (T)", () => {
    expect(readFileSync(chercherTs, "utf8")).toContain("--diff-filter=ACMRT");
  });
  it("[C-531] la sortie du mode diff ne contient jamais le nom", () => {
    const diff = fichier("docs/Quincaillerie-Zéphyrine-Ostrowska.md", NOM, "Quincaillerie Zéphyrine", "Ostrowska");
    const r = lancer(["diff", "commit 3"], diff);
    expect(r.status).toBe(2);
    const s = sortie(r).toLowerCase();
    for (const m of ["quincaillerie", "zephyrine", "zéphyrine", "ostrowska"]) expect(s).not.toContain(m);
    expect(s).toContain("commit 3");
  });
  it("[C-611] le mode diff sort 0 sur un diff propre et 1 si la liste est absente", () => {
    expect(lancer(["diff", "diff final"], fichier("a.md", "Lemoine Rénovation")).status).toBe(0);
    expect(lancer(["diff", "diff final"], fichier("a.md", "x"), { NOMS_CLIENTS: "" }).status).toBe(1);
  });
});

describe("encodage strict (B6)", () => {
  const ajoutLatin1 = Buffer.concat([Buffer.from("diff --git a/export.csv b/export.csv\n--- /dev/null\n+++ b/export.csv\n@@ -0,0 +1 @@\n+Quincaillerie Z"), Buffer.from([0xe9]), Buffer.from("phyrine Ostrowska;1\n")]);
  it("[C-611] verifierDiff refuse (code 1, « encodage non UTF-8 ») une ligne ajoutée d'un .csv en Windows-1252 contenant le nom accentué", () => {
    const r = lancer(["diff", "commit 2"], ajoutLatin1);
    expect(r.status).toBe(1);
    expect(sortie(r)).toContain("encodage non UTF-8, lieu commit 2 : convertir en UTF-8");
  });
  const utf16 = (texte: string, bom: boolean) => Buffer.concat([Buffer.from("+++ b/x.txt\n@@ -0,0 +1 @@\n+"), Buffer.from(bom ? [0xff, 0xfe] : []), Buffer.from(texte, "utf16le"), Buffer.from("\n")]);
  it("[C-611] verifierDiff refuse un fichier UTF-16 avec BOM (FF FE) contenant le nom accentué, forcé en texte", () => {
    const r = lancer(["diff", "commit 1"], utf16(NOM, true));
    expect(r.status).toBe(1);
    expect(sortie(r)).toContain("encodage non UTF-8");
  });
  it("[C-611] verifierDiff refuse un fichier UTF-16 sans BOM contenant le nom accentué, forcé en texte", () => {
    const r = lancer(["diff", "commit 1"], utf16(NOM, false));
    expect(r.status).toBe(1);
    expect(sortie(r)).toContain("encodage non UTF-8");
  });
  it("[C-611] verifierDiff refuse un octet NUL dans une ligne ajoutée", () => {
    const r = lancer(["diff", "commit 1"], Buffer.from("+++ b/x\n@@ -0,0 +1 @@\n+a\u0000b\n"));
    expect(r.status).toBe(1);
    expect(sortie(r)).toContain("encodage non UTF-8");
  });
  it("[C-611] le mode texte refuse un message de commit en Latin-1 sans en-tête encoding", () => {
    const objet = Buffer.concat([Buffer.from("tree 0000\nauthor a <a@exemple.fr> 1 +0000\ncommitter a <a@exemple.fr> 1 +0000\n\nQuincaillerie Z"), Buffer.from([0xe9]), Buffer.from("phyrine Ostrowska\n")]);
    const r = lancer(["texte", "commit 4"], objet);
    expect(r.status).toBe(1);
    expect(sortie(r)).toContain("encodage non UTF-8, lieu commit 4");
  });
  it("[C-611] le mode texte accepte l'objet commit brut, en-têtes compris, et trouve le nom (code 2)", () => {
    const objet = `tree 0000\nauthor a <a@exemple.fr> 1 +0000\ncommitter a <a@exemple.fr> 1 +0000\ngpgsig -----BEGIN\n Comment: ${NOM}\n -----END\n\nmessage\n`;
    const r = lancer(["texte", "commit 5"], objet);
    expect(r.status).toBe(2);
    expect(sortie(r)).toContain("nom interdit, commit 5, ligne 5");
  });
  it("[C-611] le mode chemins refuse un nom de fichier non UTF-8", () => {
    const r = lancer(["chemins", "chemins k"], Buffer.concat([Buffer.from("docs/z"), Buffer.from([0xe9]), Buffer.from(".md\0")]));
    expect(r.status).toBe(1);
    expect(sortie(r)).toContain("encodage non UTF-8, lieu chemins k");
  });
  it("[C-611] le mode chemins sépare par NUL, trouve le nom (tabulation comprise) et refuse un champ vide", () => {
    const tab = lancer(["chemins", "chemins k"], Buffer.from("a.md\0Quincaillerie\tZéphyrine-Ostrowska.md\0"));
    expect(tab.status).toBe(2);
    expect(sortie(tab)).toContain("nom de fichier interdit, chemins k, entrée 2 (n° 1)");
    expect(lancer(["chemins", "chemins k"], Buffer.from("a.md\0\0b.md\0")).status).toBe(1);
    expect(lancer(["chemins", "chemins k"], Buffer.from("a.md\0b.md\0")).status).toBe(0);
  });
  it("[C-531] le message de refus d'encodage ne contient ni le nom ni les octets fautifs", () => {
    const r = lancer(["diff", "commit 2"], ajoutLatin1);
    const s = sortie(r).toLowerCase();
    for (const m of ["quincaillerie", "ostrowska", "phyrine", "�", "é"]) expect(s).not.toContain(m);
  });
  it("[C-611] pre-commit refuse aussi un fichier indexé en Windows-1252", () => {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: depot, env: env({ GIT_CONFIG_GLOBAL: "/dev/null" }) });
    git("init", "-q", "-b", "main");
    writeFileSync(join(depot, "export.csv"), ajoutLatin1.subarray(ajoutLatin1.indexOf("+Q") + 1));
    git("add", "export.csv");
    const r = lancer(["pre-commit"], "");
    expect(r.status).toBe(1);
    expect(sortie(r)).toContain("encodage non UTF-8");
  });
});
