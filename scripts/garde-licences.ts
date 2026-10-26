import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

// Garde des licences : liste fermée. MPL-2.0 seulement dans ce qui n'est jamais livré (apps/api, apps/console, apps/portail) ;
// ce qui est livré chez un client n'a droit qu'aux six licences du livre (A-375, ADR 0012).

export const LIVRE = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "PostgreSQL"]);
const PERMISES = new Set([...LIVRE, "0BSD", "OFL-1.1"]);
const MPL = "MPL-2.0";

// Exceptions NOMMÉES (paquet + licence), réservées aux dépendances de développement (ADR 0007, ADR 0008 ; en production : ADR 0019).
const EXCEPTIONS_DEV: Record<string, string> = { argparse: "Python-2.0", minimatch: "BlueOak-1.0.0", nodemailer: "MIT-0" };

// Exceptions NOMMÉES pour une dépendance de PRODUCTION : caniuse-lite sous CC-BY-4.0, imposé par Next.js (ADR 0011) ; nodemailer sous MIT-0, client SMTP du connecteur de messagerie (ADR 0019).
// Comparaison exacte du nom du paquet ET de la licence entière (jamais d'atome d'une expression composée).
const EXCEPTIONS_PRODUCTION = [{ paquet: "caniuse-lite", licence: "CC-BY-4.0" }, { paquet: "nodemailer", licence: "MIT-0" }];

type Paquets = Record<string, { name: string }[]>;

// Expression SPDX : AND lie plus fort que OR, parenthèses récursives. Toute expression illisible est refusée.
export function expressionPermise(expression: string, ok: (id: string) => boolean): boolean {
  const jetons = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const ou = (): boolean => {
    let v = et();
    while (jetons[i] === "OR") {
      i++;
      const w = et();
      v = v || w;
    }
    return v;
  };
  const et = (): boolean => {
    let v = atome();
    while (jetons[i] === "AND") {
      i++;
      const w = atome();
      v = v && w;
    }
    return v;
  };
  const atome = (): boolean => {
    const j = jetons[i++];
    if (j === "(") {
      const v = ou();
      if (jetons[i++] !== ")") throw new Error("parenthèse non fermée");
      return v;
    }
    if (j === undefined || j === ")" || j === "AND" || j === "OR") throw new Error("expression illisible");
    return ok(j);
  };
  try {
    const v = ou();
    return i === jetons.length && v;
  } catch {
    return false;
  }
}

export function verifierLicences(parLicence: Paquets, nomsMpl: Set<string>, nomsProduction: Set<string> = new Set(), nomsLivres: Set<string> = new Set()): string[] {
  const erreurs: string[] = [];
  for (const [licence, paquets] of Object.entries(parLicence)) {
    const ok = (id: string, nom: string) =>
      PERMISES.has(id) || (id === MPL && nomsMpl.has(nom) && !nomsLivres.has(nom)) || (EXCEPTIONS_DEV[nom] === id && !nomsProduction.has(nom));
    for (const p of paquets) {
      if (EXCEPTIONS_PRODUCTION.some((x) => x.licence === licence && x.paquet === p.name) && nomsProduction.has(p.name)) continue;
      if (!expressionPermise(licence, (id) => ok(id, p.name))) erreurs.push(`${p.name} : licence « ${licence} » non permise`);
    }
  }
  return erreurs;
}

// Ce qui est livré chez un client : seulement les six licences du livre (A-375, A-402).
export function verifierLicencesLivrees(parLicence: Paquets, cible: string): string[] {
  const erreurs: string[] = [];
  for (const [licence, paquets] of Object.entries(parLicence)) {
    if (expressionPermise(licence, (id) => LIVRE.has(id))) continue;
    for (const p of paquets) erreurs.push(`${p.name} : licence « ${licence} » non permise dans ${cible} (livré chez un client)`);
  }
  return erreurs;
}

interface Fichier {
  nom: string;
  texte: string;
}
type Obj = Record<string, unknown>;
const estObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function lireWorkflow(f: Fichier): Obj | string {
  try {
    const doc = load(f.texte);
    return estObj(doc) ? doc : `${f.nom} : workflow illisible`;
  } catch {
    return `${f.nom} : workflow illisible`;
  }
}

// Liste blanche (C-019, C-020) : un fichier n'est accepté que dans une forme EXACTEMENT connue, tout le reste est refusé par défaut.
// On ne cherche pas à reconnaître les contournements : ajouter une action, une commande ou un réglage = modifier ces listes (relecture de l'architecte).
const canon = (v: unknown): string => String(JSON.stringify(v, (_k, x) => (estObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)));
const cles = (o: Obj, ok: string[]) => Object.keys(o).every((k) => ok.includes(k));
// Concurrence : forme EXACTE autorisée (annule les exécutions obsolètes d'une PR, jamais celles de main).
const CONCURRENCE = canon({ group: "${{ github.workflow }}-${{ github.head_ref || github.ref }}", "cancel-in-progress": "${{ github.event_name == 'pull_request' }}" });
const concurrenceOk = (doc: Obj) => doc.concurrency === undefined || canon(doc.concurrency) === CONCURRENCE;
const PERSIST = { "persist-credentials": false };
const NODE = { "node-version-file": ".nvmrc" };
// « uses » : texte EXACT connu (jamais de motif : un SHA inconnu peut venir d'un fork, « commit imposteur »).
const ACTIONS: [string, unknown[]][] = [
  ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", [undefined, PERSIST, { ...PERSIST, "fetch-depth": 0 }, { ...PERSIST, "fetch-depth": 2 }, { ...PERSIST, ref: "${{ github.event.repository.default_branch }}" }]],
  ["actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", [NODE]],
  ["actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", [{ name: "rapport-couverture", path: "rapport-couverture.json" }]],
  ["github/codeql-action/init@8498dc4c2b27cdd99baf0f87955b29ebbf30c78d", [{ languages: "javascript-typescript", "build-mode": "none" }]],
  ["github/codeql-action/analyze@8498dc4c2b27cdd99baf0f87955b29ebbf30c78d", [undefined]],
  ["gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7", [undefined]],
];
// ADR 0014 : attestation de provenance des images dérivées, par SHA du tag v4.2.2. Acceptée dans images-derivees.yml seulement.
const FICHIER_IMAGES = "images-derivees.yml";
const ACTIONS_IMAGES: [string, unknown[]][] = [
  ["actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8", [{ "subject-name": "ghcr.io/will383842/axion-automatisations-clients/postgres-derivee", "subject-digest": "${{ steps.pousser.outputs.empreinte }}", "push-to-registry": true }, { "subject-name": "ghcr.io/will383842/axion-automatisations-clients/postgres-socle", "subject-digest": "${{ steps.pousser-socle.outputs.empreinte }}", "push-to-registry": true }]],
];
// Seul bloc « services » connu : le Mailpit de harnais.yml, comparé en forme canonique.
const SERVICES = canon({
  mailpit: {
    image: "axllent/mailpit:v1.32.0@sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498",
    ports: ["127.0.0.1:8025:8025", "127.0.0.1:1025:1025"],
    options: '--health-cmd "/mailpit readyz" --health-interval 2s --health-timeout 3s --health-retries 30',
  },
});
const INSTALLER = "pnpm install --frozen-lockfile";
const GARDE = "node scripts/garde-licences.ts";
// Commandes d'une ligne, texte exact.
const RUN_OK = new Set([
  "corepack enable", INSTALLER, GARDE, "pnpm -r typecheck", "pnpm lint", "pnpm test", "pnpm test:compter", "pnpm test --project packages/harnais",
  "pnpm vitest run --reporter=json --outputFile=rapport-vitest.json", "pnpm exec vitest run --project integration --reporter=json --outputFile=rapport-integration.json",
  'pnpm audit --json > "$RUNNER_TEMP/audit.json" || true', 'node scripts/audit-dependances.ts "$RUNNER_TEMP/audit.json"', "node scripts/garde-workflows.ts .github/workflows",
  "node scripts/compter-tests.ts rapport-tests.json", "node scripts/compter-tests.ts --projet integration --rapport rapport-integration.json",
  "node scripts/couverture-req.ts rapport-vitest.json rapport-playwright.json", "node scripts/garde-couleurs.ts", "node scripts/garde-donnees-reelles.ts", "node scripts/garde-migrations.ts",
  'node scripts/scanner-journaux.ts "$RUNNER_TEMP/texte"', "ops/socle/lancer.sh", "ops/socle/arreter.sh", "node scripts/garde-briques.ts",
]);
// Blocs de plusieurs lignes : empreinte SHA-256 du texte (controle-journaux ×2, nuit, socle-integration, squelettes-web).
const BLOCS = new Set([
  "91d880b8d946344fb442e64a8f8ff4c6eb2e25266d2d4323be61ae56e8cbcfc0", "5cd6fd64e4938d39c80bac4b7d85814c9c830b5c1af5f0b7ce439360ae98e36c", "e2650042d59f0d28585d19828302efac1a54e9b198fe25ec140de1ce00e69b2e",
  "0fd60f11b15695a31240caf38b0dc6261a44d31e6e69d3b3efb7a109e0d33917", "1ee1fc7af3202d9908c3dff871f61c9ad720a975cdfec88cf13c6d5eae58d11c",
  "44f16a54a5416fefe33b04f0b5a9373d797664be6bc1fdcc8bb47d4a8a506046", // garde-briques : attestation de chaque image dérivée
]);
// Les blocs de images-derivees.yml (dérivée alpine, puis image du socle) (ADR 0014) : acceptés dans ce fichier seulement.
const BLOCS_IMAGES = new Set([
  "2cc82b403c67a4e486037fa8bca9d916b741363c20a1d849a3f7b53ca77beb75", "2b4e7f6c62e6037dcd3066d1bfdf04198fdb53ba15ad1155d64f01436d6fbf28", "141ad4b7e734456991654ae2e26f05ec4899efb2ad3828e0b77650ceec614614",
  "95587cf550dce1fbc69f7e8d88b456602526e53d79e7102cded09b33f724b58f", "89dd0a51528b351200f20dee084db620976d939f9eda0c815e52b9fba10202bd",
  "668bc1cd1c3f9cf87bbb799911b0839c3d0addfe804d840d4979b978a47ed6c7", "9139d805fe20a8cd38599f90af5d787089a60055efbd99dbed6071e9638f4bab", "cecf1891da06cd0c97652db0656ef7b12e5e75df0f9988ed986e9b7f89e4273a", "4af8f781253d648981d1bb01f72cb2b67a77173a1b94abecf84918847d6679b4", "9904653be6709787daf7d81edc6b9784cace85d9cf5daf19fa02541d3c5a1099",
]);
const ENV_OK = ["GH_TOKEN", "DEPOT", "RUN_ID", "CORPS_PR", "GITHUB_TOKEN", "SOCLE_INTEGRATION", "NODE_ENV", "MAILPIT_API", "MAILPIT_SMTP_HOTE", "MAILPIT_SMTP_PORT", "NEXT_TELEMETRY_DISABLED"];
const envOk = (o: unknown) => o === undefined || (estObj(o) && cles(o, ENV_OK));

function etapeConnue(e: Obj, composite: boolean, fichier: string): string | undefined {
  if (!cles(e, ["name", "id", "if", "continue-on-error", "env", "uses", "with", "run", ...(composite ? ["shell"] : [])]) || !envOk(e.env)) return "étape de forme inconnue";
  if ((e.uses === undefined) === (e.run === undefined)) return "étape : « uses » ou « run », un seul";
  if (typeof e.uses === "string") {
    const uses = e.uses;
    const action = [...ACTIONS, ...(fichier === FICHIER_IMAGES ? ACTIONS_IMAGES : [])].find(([connu]) => connu === uses);
    return e.shell === undefined && action?.[1].some((w) => canon(w) === canon(e.with)) ? undefined : `action « ${uses} » ou ses réglages hors liste blanche`;
  }
  const run = typeof e.run === "string" ? e.run.trim() : "";
  if (e.with !== undefined || e.shell !== (composite ? "bash" : undefined)) return "étape « run » avec réglage de shell ou « with » inconnu";
  if (run === INSTALLER && (e.if !== undefined || e["continue-on-error"] !== undefined)) return "l'installation figée ne peut être ni conditionnelle ni tolérée";
  return RUN_OK.has(run) || BLOCS.has(createHash("sha256").update(run).digest("hex")) || (fichier === FICHIER_IMAGES && BLOCS_IMAGES.has(createHash("sha256").update(run).digest("hex"))) ? undefined : `commande hors liste blanche : ${run.split("\n")[0]?.slice(0, 80)}`;
}

// Forme connue d'un workflow ou d'une action composite (le nom « action.yml » désigne une action composite).
function formeConnue(f: Fichier, doc: Obj): string[] {
  const composite = /(^|\/)action\.ya?ml$/.test(f.nom);
  let jobs: unknown[];
  if (composite) {
    if (!cles(doc, ["name", "description", "runs"]) || !estObj(doc.runs) || doc.runs.using !== "composite" || !cles(doc.runs, ["using", "steps"])) return [`${f.nom} : action de forme inconnue`];
    jobs = [doc.runs];
  } else {
    if (!cles(doc, ["name", "on", "permissions", "concurrency", "jobs"]) || !concurrenceOk(doc) || !estObj(doc.jobs) || !Object.keys(doc.jobs).length) return [`${f.nom} : workflow de forme inconnue`];
    jobs = Object.values(doc.jobs);
  }
  const clesJob = composite ? ["using", "steps"] : ["name", "runs-on", "permissions", "services", "env", "steps", "needs", "if", "timeout-minutes"];
  return jobs.flatMap((job) => {
    if (!estObj(job) || !cles(job, clesJob) || !envOk(job.env) || (!composite && (job["runs-on"] !== "ubuntu-latest" || (job.services !== undefined && canon(job.services) !== SERVICES))) || !Array.isArray(job.steps) || !job.steps.length) return [`${f.nom} : job de forme inconnue`];
    return job.steps.map((e) => (estObj(e) ? etapeConnue(e, composite, f.nom) : "étape illisible")).filter((m) => m).map((m) => `${f.nom} : ${m}`);
  });
}

// Scripts de package.json : texte exact seulement (ils s'exécutent par « pnpm <script> », y compris prepare, preinstall, postinstall).
const SCRIPTS_OK = new Set([
  "tsc --noEmit -p tsconfig.json", "tsc --noEmit -p tsconfig.json --allowImportingTsExtensions", "tsc --noEmit -p tsconfig.json --jsx react-jsx --lib ES2023,DOM,DOM.Iterable",
  "NEXT_TELEMETRY_DISABLED=1 next dev", "NEXT_TELEMETRY_DISABLED=1 next build", "NEXT_TELEMETRY_DISABLED=1 node .next/standalone/apps/console/server.js", "NEXT_TELEMETRY_DISABLED=1 node .next/standalone/apps/portail/server.js",
  "pnpm -r typecheck && pnpm lint && pnpm test", "eslint .", "vitest run", "vitest run --reporter=json --outputFile=rapport-tests.json",
  "git rev-parse --git-dir >/dev/null 2>&1 && git config core.hooksPath .githooks || true", "cd ../.. && vitest run --project packages/contrats", "cd ../.. && vitest run --project packages/sdk-module",
  "node scripts/signer-fixtures.ts && node scripts/empreinte.ts", "node scripts/generer-css.ts",
]);
export function verifierScriptsPaquets(fichiers: Fichier[]): string[] {
  const erreurs: string[] = [];
  for (const f of fichiers) {
    let scripts: unknown;
    try {
      scripts = (JSON.parse(f.texte) as Obj).scripts;
    } catch {
      erreurs.push(`${f.nom} : illisible`);
      continue;
    }
    if (scripts !== undefined && !estObj(scripts)) erreurs.push(`${f.nom} : « scripts » de forme inconnue`);
    for (const [cle, cmd] of Object.entries(estObj(scripts) ? scripts : {})) if (typeof cmd !== "string" || !SCRIPTS_OK.has(cmd)) erreurs.push(`${f.nom} (script ${cle}) : commande hors liste blanche`);
  }
  return erreurs;
}

// C-020 : toute forme de workflow ou d'action est refusée si elle n'est pas dans la liste blanche, donc aucune installation hors « pnpm install --frozen-lockfile ».
export function verifierInstallationsFigees(workflows: Fichier[]): string[] {
  return workflows.flatMap((f) => {
    const doc = lireWorkflow(f);
    return typeof doc === "string" ? [doc] : formeConnue(f, doc);
  });
}

const FILTRES_PR = ["branches", "branches-ignore", "paths", "paths-ignore", "types"];
function surChaquePr(doc: Obj): boolean {
  const on = doc.on ?? doc["true"];
  if (on === "pull_request") return true;
  if (Array.isArray(on)) return on.includes("pull_request");
  if (!estObj(on) || !("pull_request" in on)) return false;
  const pr = on.pull_request;
  return pr === null || (estObj(pr) && FILTRES_PR.every((k) => !(k in pr)));
}

// C-019 : le job de la garde a EXACTEMENT cette forme : mêmes étapes, même ordre, rien de plus (ni with, ni shell, ni env, ni needs, ni defaults).
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const MODELE_GARDE: ((e: Obj) => boolean)[] = [
  (e) => cles(e, ["uses", "with"]) && e.uses === CHECKOUT && [undefined, PERSIST].some((w) => canon(w) === canon(e.with)),
  (e) => cles(e, ["uses", "with"]) && e.uses === SETUP_NODE && canon(e.with) === canon(NODE),
  ...["corepack enable", INSTALLER, GARDE].map((cmd) => (e: Obj) => cles(e, ["run"]) && typeof e.run === "string" && e.run.trim() === cmd),
];
const jobLanceGarde = (job: Obj): boolean => {
  const steps = job.steps;
  return cles(job, ["name", "runs-on", "steps"]) && job["runs-on"] === "ubuntu-latest" && Array.isArray(steps) && steps.length === MODELE_GARDE.length && MODELE_GARDE.every((ok, k) => estObj(steps[k]) && ok(steps[k]));
};

export function verifierWorkflowsLicences(workflows: Fichier[]): string[] {
  const erreurs: string[] = [];
  let trouve = false;
  for (const f of workflows) {
    const doc = lireWorkflow(f);
    if (typeof doc === "string") {
      erreurs.push(doc);
      continue;
    }
    if (!surChaquePr(doc) || !cles(doc, ["name", "on", "permissions", "concurrency", "jobs"]) || !concurrenceOk(doc)) continue;
    if (Object.values(estObj(doc.jobs) ? doc.jobs : {}).some((job) => estObj(job) && jobLanceGarde(job))) trouve = true;
  }
  if (!trouve) erreurs.push("aucun workflow ne lance « node scripts/garde-licences.ts » sur chaque PR dans la forme exacte attendue");
  return erreurs;
}

// pnpm écrit un message en texte brut (et non du JSON) quand aucun paquet ne correspond.
const lister = (filtres: string[] = [], options: string[] = []): Paquets => {
  const sortie = execFileSync("pnpm", [...filtres, "licenses", "list", "--json", ...options], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return sortie.trimStart().startsWith("{") ? (JSON.parse(sortie) as Paquets) : {};
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const serveur = lister(["--filter", "@axion-auto/api", "--filter", "@axion-auto/console", "--filter", "@axion-auto/portail"]);
  const nomsMpl = new Set((serveur[MPL] ?? []).map((p) => p.name));
  const nomsProduction = new Set(Object.values(lister([], ["--prod"])).flatMap((ps) => ps.map((p) => p.name)));
  const livres = lister(["--filter", "@axion-auto/executeur", "--filter", "@axion-auto/sdk-module", "--filter", "@axion-auto/connecteurs-*", "--filter", "@axion-auto/module-*"], ["--prod"]);
  const nomsLivres = new Set(Object.values(livres).flatMap((ps) => ps.map((p) => p.name)));
  const dossier = ".github/workflows";
  const workflows = readdirSync(dossier).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ nom: f, texte: readFileSync(join(dossier, f), "utf8") }));
  const composites = ((): Fichier[] => {
    try {
      return readdirSync(".github/actions", { recursive: true, encoding: "utf8" }).filter((f) => /(^|\/)action\.ya?ml$/.test(f)).map((f) => ({ nom: f, texte: readFileSync(join(".github/actions", f), "utf8") }));
    } catch {
      return [];
    }
  })();
  const paquets = readdirSync(".", { recursive: true, encoding: "utf8" }).filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules")).map((f) => ({ nom: f, texte: readFileSync(f, "utf8") }));
  const erreurs = [
    ...verifierLicences(lister(), nomsMpl, nomsProduction, nomsLivres),
    ...verifierLicencesLivrees(livres, "apps/executeur, sdk-module, connecteurs, modules"),
    ...verifierWorkflowsLicences(workflows),
    ...verifierInstallationsFigees([...workflows, ...composites]),
    ...verifierScriptsPaquets(paquets),
  ];
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
