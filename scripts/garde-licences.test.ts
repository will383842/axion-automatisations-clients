import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("garde-licences : lecture des workflows", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  const wf = (corps: string, declencheur = "on:\n  pull_request:\n") => `name: x\n${declencheur}permissions:\n  contents: read\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${sha}\n${corps}`;
  const dossier = () => {
    const base = fileURLToPath(new URL("../.github/workflows", import.meta.url));
    return readdirSync(base).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ nom: f, texte: readFileSync(`${base}/${f}`, "utf8") }));
  };
  it("[C-019] garde-licences tourne sur chaque PR", () => {
    expect(verifierWorkflowsLicences(dossier())).toEqual([]);
  });
  it("[C-019] la garde refuse l'absence de job, un déclencheur limité, un job conditionnel et une étape tolérée", () => {
    const etape = "      - run: node scripts/garde-licences.ts\n";
    const run = (t: string) => verifierWorkflowsLicences([{ nom: "w.yml", texte: t }]);
    expect(run(wf(etape))).toEqual([]);
    expect(run(wf("      - run: echo rien\n"))).not.toEqual([]);
    expect(run(wf(etape, "on:\n  push:\n"))).not.toEqual([]);
    expect(run(wf(etape, "on:\n  pull_request:\n    branches: [autre]\n"))).not.toEqual([]);
    expect(run(wf(etape, "on:\n  pull_request:\n    paths: ['docs/**']\n"))).not.toEqual([]);
    expect(run(wf(etape, "on: [pull_request]\n"))).toEqual([]);
    expect(run(wf(etape.replace("      - run", "      - if: false\n        run")))).not.toEqual([]);
    expect(run(wf(etape.replace("      - run", "      - continue-on-error: true\n        run")))).not.toEqual([]);
    expect(run(wf("      # - run: node scripts/garde-licences.ts\n"))).not.toEqual([]);
    expect(run(wf("      - run: echo node scripts/garde-licences.ts\n"))).not.toEqual([]);
    expect(run(wf("      - run: node scripts/garde-licences.ts || true\n"))).not.toEqual([]);
  });
  it("[C-020] chaque installation de la CI utilise --frozen-lockfile", () => {
    expect(verifierInstallationsFigees(dossier())).toEqual([]);
  });
  it("[C-020] la garde des installations refuse les écritures qui contournent le verrou", () => {
    const run = (cmd: string) => verifierInstallationsFigees([{ nom: "w.yml", texte: wf(`      - run: ${cmd}\n`) }]);
    expect(run("pnpm install --frozen-lockfile")).toEqual([]);
    expect(run("corepack enable && pnpm install --frozen-lockfile")).toEqual([]);
    for (const mauvais of [
      "pnpm install",
      "pnpm i",
      "pnpm  install",
      "pnpm install --no-frozen-lockfile",
      "pnpm install --frozen-lockfile=false",
      "pnpm install # --frozen-lockfile",
      "echo --frozen-lockfile && pnpm install",
      "pnpm install; echo --frozen-lockfile",
      "pnpm -r install",
      "pnpm --filter x install",
      "pnpm add exemple",
      "pnpm update",
      "npm install",
      "yarn install",
      "bun install",
    ]) {
      expect(run(mauvais), mauvais).not.toEqual([]);
    }
    expect(run("npm ci")).toEqual([]);
  });
  it("[C-020] la garde des installations lit un bloc « run: | » sur plusieurs lignes et refuse run_install", () => {
    const bloc = wf("      - run: |\n          corepack enable\n          pnpm install\n");
    expect(verifierInstallationsFigees([{ nom: "w.yml", texte: bloc }])).not.toEqual([]);
    const action = wf("      - uses: pnpm/action-setup@" + sha + "\n        with:\n          run_install: true\n");
    expect(verifierInstallationsFigees([{ nom: "w.yml", texte: action }])).not.toEqual([]);
  });
  it("[C-019] la garde n'accepte que la forme exacte, sans option, redirection, shell, dossier, env ni dépendance", () => {
    const run = (t: string) => verifierWorkflowsLicences([{ nom: "w.yml", texte: t }]);
    const garde = "node scripts/garde-licences.ts";
    for (const mauvais of ["node --check scripts/garde-licences.ts", "node -e 0 scripts/garde-licences.ts", `${garde} &`, `${garde} | cat`, `${garde} x`, `${garde}\n          true`]) {
      expect(run(wf(`      - run: |\n          ${mauvais}\n`)), mauvais).not.toEqual([]);
    }
    const sup = (extra: string) => run(wf(`      - ${extra}\n        run: ${garde}\n`));
    expect(sup('shell: "bash {0}"')).not.toEqual([]);
    expect(sup("working-directory: docs")).not.toEqual([]);
    expect(sup("env:\n          NODE_OPTIONS: --x")).not.toEqual([]);
    expect(run(wf(`      - run: ${garde}\n`).replace("    steps:", "    needs: [absent]\n    steps:"))).not.toEqual([]);
    expect(run(wf(`      - run: ${garde}\n`).replace("    steps:", "    env:\n      NODE_OPTIONS: --x\n    steps:"))).not.toEqual([]);
    expect(run(wf(`      - run: ${garde}\n`).replace("permissions:", "defaults:\n  run:\n    shell: bash {0}\npermissions:"))).not.toEqual([]);
    expect(run(wf(`      - run: ${garde}\n`).replace("    steps:", "    defaults:\n      run:\n        working-directory: docs\n    steps:"))).not.toEqual([]);
    expect(run(wf(`      - run: echo ok > scripts/garde-licences.ts\n      - run: ${garde}\n`))).not.toEqual([]);
  });
  it("[C-020] la garde des installations refuse les lanceurs, options et formes inconnues", () => {
    const run = (cmd: string) => verifierInstallationsFigees([{ nom: "w.yml", texte: wf(`      - run: ${JSON.stringify(cmd)}\n`) }]);
    for (const mauvais of [
      "pnpm --reporter silent install",
      "pnpm --loglevel error install",
      "pnpm --inconnue install",
      "pnpm it",
      "pnpm install-test",
      "pnpm exec pnpm install",
      "pnpm dlx x",
      "npx pnpm install",
      "bash -ec 'pnpm install'",
      "sh -xc 'pnpm install'",
      "eval 'pnpm install'",
      "echo $(pnpm install)",
      "echo `pnpm install`",
      "npm --prefix x install",
      "yarn --cwd x install",
      "bash installer.sh",
      "./installer.sh",
    ]) {
      expect(run(mauvais), mauvais).not.toEqual([]);
    }
    expect(run("pnpm --reporter silent install --frozen-lockfile")).toEqual([]);
    expect(run("bash -ec 'pnpm install --frozen-lockfile'")).toEqual([]);
  });
  it("[C-020] uses et with ne tiennent pas compte de la casse ; les actions composites et les scripts de package.json sont lus", () => {
    const action = (uses: string, cle: string) => verifierInstallationsFigees([{ nom: "w.yml", texte: wf(`      - uses: ${uses}@${sha}\n        with:\n          ${cle}: true\n`) }]);
    expect(action("PNPM/action-setup", "run_install")).not.toEqual([]);
    expect(action("pnpm/action-setup", "Run_Install")).not.toEqual([]);
    const composite = "name: x\nruns:\n  using: composite\n  steps:\n    - run: pnpm install\n      shell: bash\n";
    expect(verifierInstallationsFigees([{ nom: "action.yml", texte: composite }])).not.toEqual([]);
    expect(verifierScriptsPaquets([{ nom: "package.json", texte: '{"scripts":{"prepare":"pnpm install"}}' }])).not.toEqual([]);
    expect(verifierScriptsPaquets([{ nom: "package.json", texte: '{"scripts":{"test":"vitest run"}}' }])).toEqual([]);
    expect(verifierScriptsPaquets([{ nom: "package.json", texte: "{" }])).not.toEqual([]);
  });
  it("[C-020] un workflow illisible est refusé (échec fermé)", () => {
    expect(verifierInstallationsFigees([{ nom: "w.yml", texte: "jobs: [" }])).not.toEqual([]);
    expect(verifierWorkflowsLicences([{ nom: "w.yml", texte: "jobs: [" }])).not.toEqual([]);
  });
});
