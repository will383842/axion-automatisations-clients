import { describe, expect, it } from "vitest";
import { evaluer, relever } from "./releve-trivy.js";

const JOUR = 86_400_000;
const maintenant = new Date("2026-10-25T00:00:00Z");
const il_y_a = (jours: number) => new Date(maintenant.getTime() - jours * JOUR).toISOString();
const rapport = (...vulns: object[]) => ({ Results: [{ Target: "x", Vulnerabilities: vulns }] });
const avis = (id: string, Severity: string, jours: number, FixedVersion: string | undefined = "2.0") => ({
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
    expect(evaluer(rapport(avis("CVE-C", "CRITICAL", 90, undefined), avis("CVE-D", "MEDIUM", 90)), "img", maintenant)).toEqual([]);
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
    expect(relever(rapport(avis("CVE-F", "HIGH", 8, undefined)))).toEqual(["CVE-F HIGH paquet 1.0 → aucune (usr/local/bin/outil)"]);
    expect(relever(null)).toEqual([]);
  });
});
