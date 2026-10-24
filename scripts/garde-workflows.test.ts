import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifierDossier, verifierWorkflow } from "./garde-workflows.js";

const fixture = (nom: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/workflows/${nom}`, import.meta.url)), "utf8");
const erreurs = (nom: string) => verifierWorkflow(nom, fixture(nom));

describe("garde-workflows", () => {
  it("accepte un workflow conforme", () => {
    expect(erreurs("bon.yml")).toEqual([]);
  });
  it("[C-529] garde-workflows refuse pull_request_target", () => {
    expect(erreurs("pr-target.yml").join("\n")).toContain("pull_request_target");
  });
  it("[C-528] garde-workflows refuse self-hosted", () => {
    expect(erreurs("self-hosted.yml").join("\n")).toContain("self-hosted");
  });
  it("[C-529] garde-workflows refuse l'absence de permissions", () => {
    expect(erreurs("sans-permissions.yml").join("\n")).toContain("permissions");
  });
  it("[C-529] garde-workflows refuse permissions: write-all", () => {
    expect(erreurs("write-all.yml").join("\n")).toContain("write-all");
  });
  it("[C-529] garde-workflows accepte secrets.GITHUB_TOKEN et refuse secrets.AUTRE dans un workflow pull_request", () => {
    expect(erreurs("bon.yml")).toEqual([]);
    expect(erreurs("secret-pr.yml").join("\n")).toContain("secrets.AUTRE");
  });
  it("[C-529] garde-workflows refuse une action non épinglée par SHA", () => {
    expect(erreurs("action-non-epinglee.yml").join("\n")).toContain("actions/checkout@v4");
  });
  it("[C-529] garde-workflows refuse un environment sur pull_request", () => {
    expect(erreurs("environment-pr.yml").join("\n")).toContain("environment");
  });
  it("[C-529] garde-workflows refuse pull_request_target écrit entre accolades", () => {
    expect(erreurs("pr-target-accolades.yml").join("\n")).toContain("pull_request_target");
  });
  it("[C-529] garde-workflows refuse un checkout sans persist-credentials: false", () => {
    expect(erreurs("checkout-sans-persist.yml").join("\n")).toContain("persist-credentials");
  });
  it("[C-529] garde-workflows refuse une action non épinglée écrite entre accolades", () => {
    expect(erreurs("uses-accolades.yml").join("\n")).toContain("evil/act@v1");
  });
  it("[C-529] garde-workflows refuse un uses sur plusieurs lignes ou à valeur sur la ligne suivante", () => {
    expect(erreurs("uses-multiligne.yml")).not.toEqual([]);
    expect(erreurs("uses-ligne-suivante.yml")).not.toEqual([]);
  });
  it("[C-529] garde-workflows accepte une action épinglée écrite entre accolades", () => {
    expect(erreurs("uses-accolades-epinglee.yml")).toEqual([]);
  });
  it("[C-529] garde-workflows est vert sur les workflows réels du dépôt", () => {
    expect(verifierDossier(fileURLToPath(new URL("../.github/workflows", import.meta.url)))).toEqual([]);
  });
  it("[C-529] garde-workflows refuse toJSON(secrets) dans un workflow pull_request", () => {
    expect(erreurs("secret-tojson.yml").join("\n")).toContain("secrets");
  });
  it("[C-529] garde-workflows refuse secrets['AUTRE'] dans un workflow pull_request", () => {
    expect(erreurs("secret-crochets.yml").join("\n")).toContain("secrets");
  });
  it("[C-528] garde-workflows refuse une étiquette runs-on maison", () => {
    expect(erreurs("etiquette-maison.yml").join("\n")).toContain("runs-on");
  });
  it("[C-529] garde-workflows accepte une image docker épinglée par empreinte", () => {
    const sha = "a".repeat(64);
    const texte = `name: D\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker://alpine@sha256:${sha}\n`;
    expect(verifierWorkflow("d.yml", texte)).toEqual([]);
  });
  describe("permissions statuses et checks en écriture", () => {
    const enTete = (perms: string) => `name: P\non:\n  push:\n${perms}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`;
    const duJob = (perms: string) => `name: P\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n${perms}\n    steps:\n      - run: echo ok\n`;
    it("[C-529] garde-workflows refuse statuses: write au niveau du fichier", () => {
      expect(verifierWorkflow("s.yml", enTete("permissions:\n  contents: read\n  statuses: write")).join("\n")).toContain("statuses: write");
    });
    it("[C-529] garde-workflows refuse checks: write au niveau d'un job", () => {
      expect(verifierWorkflow("c.yml", duJob("    permissions:\n      checks: write")).join("\n")).toContain("checks: write");
    });
    it("[C-529] garde-workflows refuse les écritures abrégées, entre accolades ou entre guillemets", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions: { contents: read, statuses: write }"))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", duJob("    permissions: {checks: write}"))).not.toEqual([]);
      expect(verifierWorkflow("d.yml", enTete("permissions:\n  \"statuses\": \"write\""))).not.toEqual([]);
      expect(verifierWorkflow("e.yml", enTete("permissions: 'write-all'"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows accepte contents: read et statuses: read", () => {
      expect(verifierWorkflow("ok.yml", enTete("permissions:\n  contents: read\n  statuses: read\n  checks: read"))).toEqual([]);
    });
  });
});
