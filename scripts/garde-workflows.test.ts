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

// T1A-16 : chaîne de déploiement protégée. Chaque attaque part d'un fichier conforme (deploiement-bon.yml, images-bon.yml) et y ajoute UNE faute.
describe("chaîne de déploiement protégée (T1A-16)", () => {
  const dep = fixture("deploiement-bon.yml");
  const img = fixture("images-bon.yml");
  const deploiement = (texte: string) => verifierWorkflow("deploiement.yml", texte);
  const images = (texte: string) => verifierWorkflow("images.yml", texte);
  const remplacer = (texte: string, de: string, par: string) => {
    expect(texte).toContain(de);
    return texte.replace(de, par);
  };

  it("[C-388] les fichiers conformes sont acceptés", () => {
    expect(deploiement(dep)).toEqual([]);
    expect(images(img)).toEqual([]);
  });
  it("[C-388] garde-workflows refuse un workflow déclenché par pull_request qui cite COOLIFY", () => {
    const pr = "name: x\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: curl -H \"$J\" https://exemple.test\n        env:\n          J: ${{ secrets.COOLIFY_JETON }}\n";
    expect(verifierWorkflow("autre.yml", pr).join("\n")).toContain("COOLIFY");
    expect(verifierWorkflow("autre.yml", pr.replace("COOLIFY_JETON", "coolify_jeton")).join("\n")).toContain("COOLIFY");
  });
  it("[C-388] garde-workflows refuse deploiement.yml avec un déclencheur push", () => {
    expect(deploiement(remplacer(dep, "on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:")).join("\n")).toContain("workflow_dispatch");
  });
  it("[C-388] deploiement.yml refuse un déclencheur ajouté en liste, workflow_call ou schedule (lu par l'analyseur YAML)", () => {
    expect(deploiement(dep.replace(/on:\n {2}workflow_dispatch:\n(?: {4,}.*\n)+/, "on: [workflow_dispatch, pull_request]\n"))).not.toEqual([]);
    expect(deploiement(remplacer(dep, "on:\n  workflow_dispatch:", "on:\n  workflow_call:\n  workflow_dispatch:"))).not.toEqual([]);
    expect(deploiement(remplacer(dep, "on:\n  workflow_dispatch:", "on:\n  schedule:\n    - cron: \"0 3 * * *\"\n  workflow_dispatch:"))).not.toEqual([]);
  });
  it("[C-388] garde-workflows refuse packages: write ailleurs que dans images.yml", () => {
    expect(verifierWorkflow("autre.yml", img).join("\n")).toContain("packages");
    expect(deploiement(remplacer(dep, "permissions:\n  contents: read\njobs", "permissions:\n  contents: read\n  packages: write\njobs")).join("\n")).toContain("packages");
  });
  it("[C-388] images.yml : packages: write seulement dans le job publier, jamais en tête", () => {
    expect(images(remplacer(img, "permissions:\n  contents: read\njobs", "permissions:\n  contents: read\n  packages: write\njobs")).join("\n")).toContain("packages");
    expect(images(remplacer(img, "    runs-on: ubuntu-latest\n    strategy", "    runs-on: ubuntu-latest\n    permissions:\n      packages: write\n    strategy")).join("\n")).toContain("packages");
  });
  it("[C-388] garde-workflows refuse un environment production ou recette hors deploiement.yml, sous toutes ses écritures", () => {
    const base = "name: x\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n";
    for (const env of ["environment: production", "environment: \"Recette\"", "environment:\n      name: production", "environment: ${{ inputs.cible }}"]) {
      expect(verifierWorkflow("autre.yml", `${base}    ${env}\n    steps:\n      - run: echo ok\n`).join("\n"), env).toContain("environment");
    }
  });
  it("[C-388] un environment production caché dans un second document YAML est refusé", () => {
    const deux = "name: x\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n---\njobs:\n  b:\n    environment: production\n";
    expect(verifierWorkflow("autre.yml", deux).join("\n")).toContain("environment");
  });
  it("[C-388] un autre workflow ne peut pas lancer deploiement.yml", () => {
    const lance = "name: x\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh workflow run deploiement.yml -f cible=production\n";
    expect(verifierWorkflow("autre.yml", lance).join("\n")).toContain("deploiement.yml");
  });
  it("[C-388] deploiement.yml refuse l'absence de l'étape explicite de refus hors main et du if de job", () => {
    expect(deploiement(remplacer(dep, "[ \"$REF\" = \"refs/heads/main\" ] ||", "true ||")).join("\n")).toContain("refs/heads/main");
    expect(deploiement(remplacer(dep, "    if: github.ref == 'refs/heads/main'\n", "")).join("\n")).toContain("refs/heads/main");
  });
  it("[C-388] deploiement.yml refuse un environment fixe ou une cible hors recette et production", () => {
    expect(deploiement(remplacer(dep, "environment: ${{ inputs.cible }}", "environment: recette")).join("\n")).toContain("environment");
    expect(deploiement(remplacer(dep, "options: [recette, production]", "options: [recette, production, essai]")).join("\n")).toContain("cible");
  });
  it("[C-388] deploiement.yml ne construit jamais de code : ni checkout, ni docker build", () => {
    const avecCheckout = remplacer(dep, "    steps:\n", "    steps:\n      - uses: actions/checkout@0000000000000000000000000000000000000000\n        with:\n          persist-credentials: false\n");
    expect(deploiement(avecCheckout).join("\n")).toContain("checkout");
    expect(deploiement(remplacer(dep, "echo \"Branchement prévu", "docker build -t x . && echo \"Branchement prévu")).join("\n")).toContain("docker build");
  });
  it("[C-388] deploiement.yml refuse une entrée ou un contexte GitHub interpolé dans un run (injection de script)", () => {
    expect(deploiement(remplacer(dep, "echo \"Branchement prévu", "echo ${{ inputs.empreinte }} \"Branchement prévu")).join("\n")).toContain("run");
    expect(deploiement(remplacer(dep, "echo \"Branchement prévu", "echo ${{ github.head_ref }} \"Branchement prévu")).join("\n")).toContain("run");
  });
  it("[C-388] deploiement.yml refuse une empreinte non validée", () => {
    expect(deploiement(remplacer(dep, "^sha256:[0-9a-f]{64}$", "^sha256:")).join("\n")).toContain("empreinte");
  });
  it("[C-388] deploiement.yml : un secret hors d'un job, ou secrets: inherit, est refusé", () => {
    expect(deploiement(remplacer(dep, "permissions:\n  contents: read\njobs", "permissions:\n  contents: read\nenv:\n  J: ${{ secrets.COOLIFY_JETON }}\njobs")).join("\n")).toContain("secret");
    expect(deploiement(remplacer(dep, "    environment:", "    secrets: inherit\n    environment:")).join("\n")).toContain("secret");
  });
  it("[C-391] images.yml refuse tout secret autre que GITHUB_TOKEN, et tout déclencheur hors push main et pull_request", () => {
    expect(images(remplacer(img, "          APP: ${{ matrix.app }}", "          APP: ${{ matrix.app }}\n          J: ${{ secrets.AUTRE }}")).join("\n")).toContain("AUTRE");
    expect(images(remplacer(img, "  pull_request:", "  workflow_dispatch:")).join("\n")).toContain("images.yml");
    expect(images(remplacer(img, "branches: [main]", "branches: [main, \"**\"]")).join("\n")).toContain("main");
  });
  it("[C-391] images.yml refuse un job publier sans garde « push sur main »", () => {
    expect(images(remplacer(img, "    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n", "")).join("\n")).toContain("publier");
    expect(images(remplacer(img, "github.event_name == 'push' && ", "")).join("\n")).toContain("publier");
  });
});

describe("Dockerfile et .dockerignore (T1A-16)", () => {
  const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
  const instructions = (texte: string) => texte.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  // Retourne les fautes d'un Dockerfile : amont non épinglé, mono-étape, root, .env copié, ADD distant, secret en ARG/ENV.
  const fautes = (texte: string): string[] => {
    const l = instructions(texte);
    const from = l.filter((x) => /^FROM\s/i.test(x));
    const sortie: string[] = [];
    if (from.length < 2) sortie.push("plusieurs étapes exigées");
    if (!from.every((x) => /^FROM\s+node:22-alpine@sha256:[0-9a-f]{64}(\s+AS\s+\w+)?$/i.test(x) || /^FROM\s+\w+(\s+AS\s+\w+)?$/i.test(x))) sortie.push("FROM non épinglé par empreinte");
    const users = l.filter((x) => /^USER\s/i.test(x));
    if (!/^USER\s+(node|\d{4,})$/i.test(users.at(-1) ?? "")) sortie.push("utilisateur non root exigé");
    if (l.some((x) => /^(COPY|ADD)\s/i.test(x) && /\.env/.test(x))) sortie.push(".env copié");
    if (l.some((x) => /^ADD\s+https?:/i.test(x))) sortie.push("ADD distant");
    if (l.some((x) => /^(ARG|ENV)\s+\w*(TOKEN|SECRET|PASSWORD|KEY)/i.test(x))) sortie.push("secret en ARG ou ENV");
    const derniere = l.map((x, i) => (/^FROM\s/i.test(x) ? i : -1)).filter((i) => i >= 0).at(-1) ?? 0;
    if (l.slice(derniere).some((x) => /^COPY\s+(?!--from)/i.test(x))) sortie.push("l'étape finale ne copie que depuis l'étape de construction");
    return sortie;
  };
  const apps = ["api", "console", "portail"];

  it.each(apps)("[C-391] apps/%s/Dockerfile : amont épinglé, plusieurs étapes, non root, aucun .env copié", (app) => {
    expect(fautes(lire(`apps/${app}/Dockerfile`))).toEqual([]);
  });
  it("[C-391] les attaques sur un Dockerfile sont détectées", () => {
    const bon = lire("apps/api/Dockerfile");
    const dernierFrom = bon.lastIndexOf("FROM ");
    expect(fautes(bon.replace(/@sha256:[0-9a-f]{64}/, ""))).toContain("FROM non épinglé par empreinte");
    expect(fautes(bon.replace(/^USER .*$/m, "USER root"))).toContain("utilisateur non root exigé");
    expect(fautes(`${bon}\nCOPY .env /app/.env\n`)).toContain(".env copié");
    expect(fautes(bon.slice(dernierFrom))).toContain("plusieurs étapes exigées");
    expect(fautes(bon.replace(/^USER .*$/m, "ADD https://exemple.test/x.tgz /x\nUSER node"))).toContain("ADD distant");
    expect(fautes(bon.replace(/^USER .*$/m, "ARG NPM_TOKEN\nUSER node"))).toContain("secret en ARG ou ENV");
  });
  it("[C-391] .dockerignore exclut les secrets, le dépôt git et les dépendances locales", () => {
    const lignes = instructions(lire(".dockerignore"));
    for (const motif of [".env", ".env.*", ".git", "node_modules", "*.pem", "*.key", ".next"]) expect(lignes, motif).toContain(motif);
    expect(lignes).not.toContain("!.env");
    expect(lignes.some((x) => x.startsWith("!"))).toBe(false);
  });
});
