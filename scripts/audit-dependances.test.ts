import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluerAudit } from "./audit-dependances.js";
import { verifierWorkflow } from "./garde-workflows.js";

const MAINTENANT = new Date("2026-10-24T00:00:00Z");
const ilYa = (jours: number) => new Date(MAINTENANT.getTime() - jours * 86_400_000).toISOString();
const rapport = (severity: string, jours: number) => ({
  advisories: { "1": { github_advisory_id: "GHSA-aaaa-bbbb-cccc", module_name: "paquet-exemple", severity, created: ilYa(jours) } },
});
const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");

describe("audit-dependances", () => {
  it("[LOT0-audit] une faille critique de 8 jours fait échouer", () => {
    const r = evaluerAudit(rapport("critical", 8), MAINTENANT);
    expect(r.echecs).toEqual(["GHSA-aaaa-bbbb-cccc paquet-exemple"]);
  });
  it("[LOT0-audit] une faille critique de 6 jours passe avec un avertissement", () => {
    const r = evaluerAudit(rapport("critical", 6), MAINTENANT);
    expect(r.echecs).toEqual([]);
    expect(r.avertissements).toEqual(["GHSA-aaaa-bbbb-cccc paquet-exemple"]);
  });
  it("[LOT0-audit] une haute de 31 jours fait échouer", () => {
    expect(evaluerAudit(rapport("high", 31), MAINTENANT).echecs).toHaveLength(1);
  });
  it("[LOT0-audit] une haute de 29 jours passe, une moyenne ancienne est ignorée", () => {
    expect(evaluerAudit(rapport("high", 29), MAINTENANT).echecs).toEqual([]);
    expect(evaluerAudit(rapport("moderate", 400), MAINTENANT)).toEqual({ echecs: [], avertissements: [] });
  });
  it("[LOT0-audit] une date illisible fait échouer (jamais de passage par défaut)", () => {
    const r = { advisories: { "1": { github_advisory_id: "GHSA-x", module_name: "p", severity: "critical" } } };
    expect(evaluerAudit(r, MAINTENANT).echecs).toHaveLength(1);
  });
  it("[LOT0-audit] un rapport sans avis ni métadonnées (audit en erreur) fait échouer", () => {
    expect(evaluerAudit({ error: { code: "ERR" } } as never, MAINTENANT).echecs).toHaveLength(1);
    expect(evaluerAudit({ advisories: {}, metadata: {} } as never, MAINTENANT).echecs).toEqual([]);
  });
  it("[C-529] garde-workflows (T0-08) accepte nuit.yml : aucun secret, déclencheurs schedule et workflow_dispatch seulement", () => {
    const t = lire(".github/workflows/nuit.yml");
    expect(verifierWorkflow("nuit.yml", t)).toEqual([]);
    expect(t).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(t).toMatch(/^\s+schedule:/m);
    expect(t).toMatch(/^\s+workflow_dispatch:/m);
    expect(t).not.toMatch(/^\s+(pull_request|pull_request_target|push|workflow_run):/m);
    expect(t).toMatch(/^permissions:\n\s+contents: read/m);
    expect(t).toContain("github/codeql-action/");
  });
  it("[C-531] controle-journaux.yml suit aussi nuit", () => {
    expect(lire(".github/workflows/controle-journaux.yml")).toMatch(/workflows: \[CI, nuit\]/);
  });
  it("[LOT0-audit] audit-dependances.yml tourne sur PR et la nuit, sans secret", () => {
    const t = lire(".github/workflows/audit-dependances.yml");
    expect(verifierWorkflow("audit-dependances.yml", t)).toEqual([]);
    expect(t).toMatch(/^\s+pull_request:/m);
    expect(t).toMatch(/^\s+schedule:/m);
  });
});
