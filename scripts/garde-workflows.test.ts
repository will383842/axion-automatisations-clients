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
    it("[C-529] garde-workflows refuse une valeur de statuses ou checks absente ou à la ligne suivante", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions:\n  contents: read\n  statuses:\n    write"))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", enTete("permissions: {\n  contents: read,\n  checks:\n  write }"))).not.toEqual([]);
      expect(verifierWorkflow("c.yml", enTete("permissions:\n  contents: read\n  statuses:"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows refuse un scalaire bloc, une étiquette, une clé explicite ou une casse différente", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions:\n  statuses: >-\n    write"))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", enTete("permissions:\n  statuses: !!str write"))).not.toEqual([]);
      expect(verifierWorkflow("c.yml", enTete("permissions:\n  ? statuses\n  : write"))).not.toEqual([]);
      expect(verifierWorkflow("d.yml", enTete("permissions:\n  statuses: WRITE"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows refuse ancre, alias et fusion dans tout workflow", () => {
      const ancre = verifierWorkflow("a.yml", `x-w: &w write\n${enTete("permissions:\n  statuses: *w")}`);
      expect(ancre.join("\n")).toContain("ancre");
      expect(verifierWorkflow("b.yml", enTete("permissions: &p\n  contents: read\n  <<: *m"))).not.toEqual([]);
      expect(verifierWorkflow("c.yml", enTete("permissions:\n  contents: read\n  <<: *m"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows refuse une valeur permissions qui n'est ni un bloc, ni read-all, ni {}", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions:\n  write-all"))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", enTete("permissions: &p write-all"))).not.toEqual([]);
      expect(verifierWorkflow("c.yml", enTete("permissions: !!str write-all"))).not.toEqual([]);
      expect(verifierWorkflow("d.yml", enTete("permissions: write"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows accepte permissions: read-all, {} et des clés avec read ou none", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions: read-all"))).toEqual([]);
      expect(verifierWorkflow("b.yml", enTete("permissions: {}"))).toEqual([]);
      expect(verifierWorkflow("c.yml", enTete("permissions:\n  contents: read\n  statuses: none\n  checks: read"))).toEqual([]);
    });
    it("[C-529] garde-workflows accepte contents: read et statuses: read", () => {
      expect(verifierWorkflow("ok.yml", enTete("permissions:\n  contents: read\n  statuses: read\n  checks: read"))).toEqual([]);
    });
  });
  describe("analyse YAML des permissions (relecture de la correction)", () => {
    const enTete = (perms: string) => `name: P\non:\n  push:\n${perms}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`;
    const duJob = (perms: string) => `name: P\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n${perms}\n    steps:\n      - run: echo ok\n`;
    it("[C-529] garde-workflows refuse write-all derrière une clé permissions entre guillemets simples ou doubles", () => {
      expect(verifierWorkflow("a.yml", duJob("    'permissions': write-all"))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", duJob("    \"permissions\": write-all"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows refuse write-all avec une espace avant les deux-points", () => {
      expect(verifierWorkflow("a.yml", duJob("    permissions : write-all"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows refuse write-all dans un job écrit en flux", () => {
      const texte = "name: P\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a: { runs-on: ubuntu-latest, permissions: write-all, steps: [ { run: echo ok } ] }\n";
      expect(verifierWorkflow("a.yml", texte)).not.toEqual([]);
    });
    it("[C-529] garde-workflows ne coupe pas sur # à l'intérieur d'une chaîne entre guillemets", () => {
      const flux = (corps: string) => `name: P\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a: { name: "x #", ${corps}, runs-on: ubuntu-latest, steps: [ { run: echo ok } ] }\n`;
      expect(verifierWorkflow("a.yml", flux("permissions: { statuses: write }"))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", flux("permissions: write-all"))).not.toEqual([]);
      const action = "name: P\non:\n  push:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - { name: \"x #\", uses: evil/act@v1 }\n";
      expect(verifierWorkflow("c.yml", action).join("\n")).toContain("evil/act@v1");
    });
    it("[C-529] garde-workflows garde un vrai commentaire coupé après les guillemets", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions:\n  contents: read # statuses: write"))).toEqual([]);
      expect(verifierWorkflow("b.yml", enTete("permissions:\n  contents: \"read\" # note"))).toEqual([]);
    });
    it("[C-529] garde-workflows refuse une clé statuses écrite avec une séquence d'échappement", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions:\n  contents: read\n  \"\\x73tatuses\": write"))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", enTete("permissions:\n  contents: read\n  \"\\u0063hecks\": write"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows refuse une clé explicite ? en flux sur deux lignes", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions: { ? statuses\n  : write }"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows refuse un YAML illisible ou une ancre au niveau d'un job", () => {
      expect(verifierWorkflow("a.yml", enTete("permissions: {").replace("steps:", "steps: ["))).not.toEqual([]);
      expect(verifierWorkflow("b.yml", duJob("    env: &e { A: b }"))).not.toEqual([]);
    });
    it("[C-529] garde-workflows accepte des permissions légitimes écrites entre guillemets ou en flux", () => {
      expect(verifierWorkflow("a.yml", duJob("    \"permissions\": { contents: read, statuses: read }"))).toEqual([]);
      expect(verifierWorkflow("b.yml", duJob("    permissions: read-all"))).toEqual([]);
    });
  });
});

describe("garde-workflows : écriture de paquets (ADR 0014, bloquant 3 de l'audit)", () => {
  const reel = readFileSync(fileURLToPath(new URL("../.github/workflows/images-derivees.yml", import.meta.url)), "utf8");
  const avec = (droits: string) => `name: x\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  j:\n    runs-on: ubuntu-latest\n    permissions:\n${droits}\n    steps:\n      - run: echo 1\n`;
  it("[A-381] le job publier de images-derivees.yml reste accepté", () => {
    expect(verifierWorkflow("images-derivees.yml", reel)).toEqual([]);
  });
  it.each(["packages", "id-token", "attestations"])("[A-381] %s: write est refusé dans tout autre fichier, même copie exacte de publier", (droit) => {
    expect(verifierWorkflow("x.yml", avec(`      contents: read\n      ${droit}: write`)).join("\n")).toContain(droit);
    expect(verifierWorkflow("x.yml", reel).join("\n")).toContain("packages");
  });
  it("[A-381] les écritures de paquets sont refusées sous toutes leurs écritures YAML", () => {
    expect(verifierWorkflow("x.yml", avec("      \"packages\": write"))).not.toEqual([]);
    expect(verifierWorkflow("x.yml", avec("      contents: read\n      id-token: \"write\""))).not.toEqual([]);
    expect(verifierWorkflow("x.yml", avec("      { attestations: write }").replace("permissions:\n      {", "permissions: {").replace(" }\n    steps", " }\n    steps"))).not.toEqual([]);
  });
  it("[A-381] dans images-derivees.yml, l'écriture est refusée en tête et dans construire", () => {
    expect(verifierWorkflow("images-derivees.yml", reel.replace("permissions:\n  contents: read\njobs:", "permissions:\n  contents: read\n  packages: write\njobs:"))).not.toEqual([]);
    expect(verifierWorkflow("images-derivees.yml", reel.replace("    permissions:\n      contents: read\n    steps:", "    permissions:\n      contents: read\n      packages: write\n    steps"))).not.toEqual([]);
  });
  it("[A-381] un fichier qui n'est pas images-derivees.yml ne peut pas reprendre le nom de job publier", () => {
    expect(verifierWorkflow("autre.yml", reel)).not.toEqual([]);
  });
});
