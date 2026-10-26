import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { evaluer, relever } from "./releve-trivy.js";

const JOUR = 86_400_000;
// Horloge réelle : le processus --garde lit la date du jour, une date figée finit par dépasser les seuils.
const maintenant = new Date();
const il_y_a = (jours: number) => new Date(maintenant.getTime() - jours * JOUR).toISOString();
const rapport = (...vulns: object[]) => ({ Results: [{ Target: "x", Vulnerabilities: vulns }] });
const avis = (id: string, Severity: string, jours: number, FixedVersion: string | null = "2.0") => ({
  VulnerabilityID: id, Severity, PublishedDate: il_y_a(jours), FixedVersion, PkgName: "paquet", InstalledVersion: "1.0", PkgPath: "usr/local/bin/outil",
});

describe("releve-trivy : évaluateur (mêmes seuils que la garde des briques)", () => {
  it("[A-381] critique corrigeable ouverte depuis plus de 7 jours : refusée", () => {
    expect(evaluer(rapport(avis("CVE-A", "CRITICAL", 8)), "img", maintenant)).toEqual(["CVE-A img"]);
    expect(evaluer(rapport(avis("CVE-A", "CRITICAL", 6)), "img", maintenant)).toEqual([]);
  });
  it("[A-381] haute corrigeable ouverte depuis plus de 30 jours : refusée", () => {
    expect(evaluer(rapport(avis("CVE-B", "HIGH", 31)), "img", maintenant)).toEqual(["CVE-B img"]);
    expect(evaluer(rapport(avis("CVE-B", "HIGH", 29)), "img", maintenant)).toEqual([]);
  });
  it("[A-381] sans correctif, ou moyenne : acceptée ; rapport invalide ou date illisible : refusé", () => {
    expect(evaluer(rapport(avis("CVE-C", "CRITICAL", 90, null), avis("CVE-D", "MEDIUM", 90)), "img", maintenant)).toEqual([]);
    expect(evaluer({}, "img", maintenant)).toEqual(["rapport Trivy invalide pour img"]);
    expect(evaluer(rapport({ ...avis("CVE-E", "HIGH", 1), PublishedDate: "n'importe quoi" }), "img", maintenant)).toEqual(["CVE-E img"]);
  });
  it("[A-381] aucune option d'ignorance : le module n'expose que relever et evaluer", async () => {
    expect(Object.keys(await import("./releve-trivy.js")).sort()).toEqual(["evaluer", "relever"]);
  });
});

describe("releve-trivy : relevé", () => {
  it("[A-381] une ligne par avis : paquet, version installée, version corrigée, chemin", () => {
    expect(relever(rapport(avis("CVE-A", "CRITICAL", 8), avis("CVE-A", "CRITICAL", 8)))).toEqual(["CVE-A CRITICAL paquet 1.0 → 2.0 (usr/local/bin/outil)"]);
    expect(relever(rapport(avis("CVE-F", "HIGH", 8, null)))).toEqual(["CVE-F HIGH paquet 1.0 → aucune (usr/local/bin/outil)"]);
    expect(relever(null)).toEqual([]);
  });
});

describe("releve-trivy : le vrai processus décide (sondes E1 et E2)", () => {
  const script = fileURLToPath(new URL("./releve-trivy.ts", import.meta.url));
  const dossier = mkdtempSync(join(tmpdir(), "releve-trivy-"));
  afterAll(() => rmSync(dossier, { recursive: true, force: true }));
  const fichier = (nom: string, contenu: string) => {
    const chemin = join(dossier, nom);
    writeFileSync(chemin, contenu);
    return chemin;
  };
  const garde = (chemin: string, image = "postgres-derivee") => spawnSync(process.execPath, [script, "--garde", chemin, image], { encoding: "utf8" }).status;
  it("[A-381] --garde sort en 1 sur un rapport refusé, quel que soit le nom d'image", () => {
    const refuse = fichier("refuse.json", JSON.stringify(rapport(avis("CVE-A", "CRITICAL", 8), avis("CVE-B", "HIGH", 31))));
    expect(garde(refuse)).toBe(1);
    expect(garde(refuse, "img")).toBe(1);
  });
  it("[A-381] --garde sort en 0 sur un rapport sans avis, ou avec seulement des avis tolérés", () => {
    expect(garde(fichier("vide.json", JSON.stringify({ Results: [] })))).toBe(0);
    expect(garde(fichier("recent.json", JSON.stringify(rapport(avis("CVE-A", "CRITICAL", 6), avis("CVE-C", "CRITICAL", 90, null)))))).toBe(0);
  });
  it("[A-381] --garde sort en 1 sur un rapport illisible, vide, sans Results ou absent", () => {
    expect(garde(fichier("illisible.json", "{pas du json"))).toBe(1);
    expect(garde(fichier("vide-total.json", ""))).toBe(1);
    expect(garde(fichier("sans-results.json", "{}"))).toBe(1);
    expect(garde(join(dossier, "absent.json"))).toBe(1);
  });
  it("[A-381] le résultat d'evaluer ne dépend pas du nom de l'image", () => {
    const refuse = rapport(avis("CVE-A", "CRITICAL", 8));
    for (const nom of ["img", "postgres-derivee", "autre"]) expect(evaluer(refuse, nom, maintenant)).toEqual([`CVE-A ${nom}`]);
    for (const nom of ["img", "postgres-derivee"]) expect(evaluer(rapport(avis("CVE-A", "CRITICAL", 6)), nom, maintenant)).toEqual([]);
    expect(evaluer({}, "postgres-derivee", maintenant)).toEqual(["rapport Trivy invalide pour postgres-derivee"]);
  });
});
