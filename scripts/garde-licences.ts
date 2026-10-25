import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

// Garde des licences : liste fermée. MPL-2.0 seulement dans ce qui n'est jamais livré (apps/api, apps/console, apps/portail) ;
// ce qui est livré chez un client n'a droit qu'aux six licences du livre (A-375, ADR 0012).

export const LIVRE = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "PostgreSQL"]);
const PERMISES = new Set([...LIVRE, "0BSD", "OFL-1.1"]);
const MPL = "MPL-2.0";

// Exceptions NOMMÉES (paquet + licence), réservées aux dépendances de développement (ADR 0007, ADR 0008).
const EXCEPTIONS_DEV: Record<string, string> = { argparse: "Python-2.0", minimatch: "BlueOak-1.0.0", nodemailer: "MIT-0" };

// Exception NOMMÉE pour une dépendance de PRODUCTION (ADR 0011) : données sous CC-BY-4.0, imposées par Next.js.
// Comparaison exacte du nom du paquet ET de la licence entière (jamais d'atome d'une expression composée).
const EXCEPTION_PRODUCTION = { paquet: "caniuse-lite", licence: "CC-BY-4.0" };

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
      if (licence === EXCEPTION_PRODUCTION.licence && p.name === EXCEPTION_PRODUCTION.paquet && nomsProduction.has(p.name)) continue;
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

// Contenu des $( … ) (parenthèses équilibrées) et des `…` : ces commandes s'exécutent aussi.
function substitutions(t: string): string[] {
  const internes: string[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "`") {
      const fin = t.indexOf("`", i + 1);
      internes.push(t.slice(i + 1, fin < 0 ? t.length : fin));
      i = fin < 0 ? t.length : fin;
    } else if (t[i] === "$" && t[i + 1] === "(") {
      let profondeur = 1;
      let j = i + 2;
      for (; j < t.length && profondeur > 0; j++) profondeur += t[j] === "(" ? 1 : t[j] === ")" ? -1 : 0;
      internes.push(t.slice(i + 2, j - 1));
    }
  }
  return internes;
}

// Découpe un « run: » en commandes (guillemets, commentaires, && || ; |, lignes continuées). « tolere » : la commande est suivie de « || ».
function commandes(script: string): { mots: string[]; tolere: boolean }[] {
  const sorties: { mots: string[]; tolere: boolean }[] = [];
  let mots: string[] = [];
  let mot = "";
  let guillemet = "";
  let present = false;
  const finMot = () => {
    if (present) mots.push(mot);
    mot = "";
    present = false;
  };
  const finCommande = (tolere: boolean) => {
    finMot();
    if (mots.length) sorties.push({ mots, tolere });
    mots = [];
  };
  const t = script.replace(/\\\r?\n/g, " ");
  for (const interne of substitutions(t)) sorties.push(...commandes(interne));
  for (let i = 0; i < t.length; i++) {
    const c = t[i] ?? "";
    const suivant = t[i + 1] ?? "";
    if (guillemet) {
      if (c === guillemet) guillemet = "";
      else mot += c;
    } else if (c === '"' || c === "'") {
      guillemet = c;
      present = true;
    } else if (c === "#" && !present) {
      while (i < t.length && t[i] !== "\n") i++;
      finCommande(false);
    } else if (c === "|" && suivant === "|") {
      i++;
      finCommande(true);
    } else if (c === "&" && suivant === "&") {
      i++;
      finCommande(false);
    } else if (c === ";" || c === "|" || c === "\n" || c === "&") finCommande(false);
    else if (/\s/.test(c)) finMot();
    else {
      mot += c;
      present = true;
    }
  }
  finCommande(false);
  return sorties;
}

const PREFIXES = new Set(["corepack", "env", "sudo", "time", "exec", "command"]);
const outil = (mots: string[]): number => mots.findIndex((m) => !PREFIXES.has(m) && !/^\w+=/.test(m));
const FIGE = /^--frozen-lockfile(?:=true)?$/;
const INCONNU = "forme non lisible, refusée par prudence";
const LANCEURS = new Set(["npx", "pnpx", "bunx", "eval", "xargs", "source", "."]);
const SANS_VALEUR = new Set(["-r", "--recursive", "-w", "--workspace-root", "-s", "--silent", "--stream", "--offline", "--prefer-offline", "--color", "--no-color", "--if-present", "--frozen-lockfile", "--ignore-scripts"]);
const AVEC_VALEUR = new Set(["--filter", "-F", "--dir", "-C", "--reporter", "--loglevel", "--prefix", "--cwd", "--workspace", "--registry"]);

// Premier mot qui n'est pas une option ; une option inconnue avant lui rend la forme illisible (undefined).
function verbeDe(reste: string[]): { verbe: string; apres: string[] } | undefined {
  for (let k = 0; k < reste.length; k++) {
    const m = reste[k] ?? "";
    if (!m.startsWith("-")) return { verbe: m, apres: reste.slice(k + 1) };
    const [nom = ""] = m.split("=");
    if (AVEC_VALEUR.has(nom)) k += m.includes("=") ? 0 : 1;
    else if (!SANS_VALEUR.has(nom)) return undefined;
  }
  return { verbe: "", apres: [] };
}

function installOk(mots: string[]): string | undefined {
  const i = outil(mots);
  const chemin = mots[i] ?? "";
  const nom = chemin.split("/").pop() ?? "";
  const reste = mots.slice(i + 1);
  if (LANCEURS.has(nom) || chemin.startsWith("./") || chemin.startsWith("/")) return `« ${nom} » : ${INCONNU}`;
  if (nom === "bash" || nom === "sh") {
    const options = reste.filter((m) => m.startsWith("-"));
    const script = reste.find((m) => !m.startsWith("-"));
    if (script === undefined || !options.some((m) => /^-[a-z]*c[a-z]*$/.test(m))) return `« ${nom} » sans -c : script non lu`;
    return commandes(script).map((c) => installOk(c.mots)).find(Boolean);
  }
  if (nom === "pnpm") {
    const v = verbeDe(reste);
    if (!v) return `pnpm : option inconnue avant le verbe (${INCONNU})`;
    const { verbe } = v;
    if (["add", "update", "up", "upgrade", "dedupe", "link", "remove", "rm"].includes(verbe)) return `« pnpm ${verbe} » modifie le verrou`;
    if (verbe === "exec") return installOk(v.apres.filter((m) => !m.startsWith("-")));
    if (["it", "install-test", "dlx", "x", "create", "env", "self-update"].includes(verbe)) return `« pnpm ${verbe} » : ${INCONNU}`;
    if (verbe !== "install" && verbe !== "i") return undefined;
    if (reste.some((m) => /^--no-frozen-lockfile$|^--frozen-lockfile=(?!true$)/.test(m)) || !reste.some((m) => FIGE.test(m))) return "pnpm install sans --frozen-lockfile";
    return undefined;
  }
  if (nom === "npm") {
    const v = verbeDe(reste);
    if (!v) return `npm : option inconnue avant le verbe (${INCONNU})`;
    return ["install", "i", "add", "update", "install-test", "it", "exec", "x"].includes(v.verbe) ? "npm install sans verrou (utiliser npm ci)" : undefined;
  }
  if (nom === "yarn" || nom === "bun") {
    const v = verbeDe(reste);
    if (!v) return `${nom} : option inconnue avant le verbe (${INCONNU})`;
    const verbe = v.verbe || "install";
    if (verbe === "add" || verbe === "upgrade") return `« ${nom} ${verbe} » modifie le verrou`;
    return verbe === "install" && !reste.some((m) => m === "--frozen-lockfile" || m === "--immutable") ? `${nom} install sans verrou figé` : undefined;
  }
  return undefined;
}

// Scripts de package.json : ils s'exécutent par « pnpm <script> » et doivent respecter la même règle.
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
    for (const [cle, cmd] of Object.entries(estObj(scripts) ? scripts : {})) {
      for (const c of typeof cmd === "string" ? commandes(cmd) : []) {
        const e = installOk(c.mots);
        if (e) erreurs.push(`${f.nom} (script ${cle}) : ${e}`);
      }
    }
  }
  return erreurs;
}

const etapes = (doc: Obj): { job: Obj; etape: Obj }[] => {
  const jobs = estObj(doc.jobs) ? Object.values(doc.jobs) : estObj(doc.runs) ? [doc.runs] : []; // action composite : « runs.steps »
  return jobs.flatMap((job) => (estObj(job) && Array.isArray(job.steps) ? job.steps.filter(estObj).map((etape) => ({ job, etape })) : []));
};

// C-020 : chaque installation de chaque workflow passe par --frozen-lockfile.
export function verifierInstallationsFigees(workflows: Fichier[]): string[] {
  const erreurs: string[] = [];
  for (const f of workflows) {
    const doc = lireWorkflow(f);
    if (typeof doc === "string") {
      erreurs.push(doc);
      continue;
    }
    for (const { etape } of etapes(doc)) {
      if (typeof etape.run === "string") {
        for (const c of commandes(etape.run)) {
          const e = installOk(c.mots);
          if (e) erreurs.push(`${f.nom} : ${e}`);
        }
      }
      if (typeof etape.uses === "string" && /^pnpm\/action-setup@/i.test(etape.uses)) {
        const cle = Object.keys(estObj(etape.with) ? etape.with : {}).find((k) => k.toLowerCase() === "run_install");
        const run = cle === undefined ? undefined : (etape.with as Obj)[cle];
        if (run !== undefined && String(run).toLowerCase() !== "false") erreurs.push(`${f.nom} : pnpm/action-setup run_install doit rester faux`);
      }
    }
  }
  return erreurs;
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

// C-019 : la garde tourne à chaque PR, sous sa seule forme exacte, sans rien qui change le shell, le dossier, l'environnement ou l'ordre des jobs.
const GARDE = "node scripts/garde-licences.ts";
const AVANT_OK = ["corepack enable", "pnpm install --frozen-lockfile"];
const ACTIONS_OK = /^(actions\/checkout|actions\/setup-node|pnpm\/action-setup)@/i;
const intact = (o: Obj, cles: string[]) => cles.every((k) => o[k] === undefined);
const sansReglage = (o: unknown) => !estObj(o) || (o.defaults === undefined && o.env === undefined);

function jobLanceGarde(job: Obj): boolean {
  if (!intact(job, ["if", "continue-on-error", "needs", "env", "defaults", "container", "strategy"]) || !Array.isArray(job.steps)) return false;
  const liste = job.steps.filter(estObj);
  const k = liste.findIndex((e) => typeof e.run === "string" && e.run.trim() === GARDE);
  const etape = liste[k];
  if (!etape || !intact(etape, ["if", "continue-on-error", "shell", "working-directory", "env"])) return false;
  return liste.slice(0, k).every((e) => intact(e, ["if", "continue-on-error", "shell", "working-directory", "env"]) && (typeof e.run === "string" ? AVANT_OK.includes(e.run.trim()) : typeof e.uses === "string" && ACTIONS_OK.test(e.uses)));
}

export function verifierWorkflowsLicences(workflows: Fichier[]): string[] {
  const erreurs: string[] = [];
  let trouve = false;
  for (const f of workflows) {
    const doc = lireWorkflow(f);
    if (typeof doc === "string") {
      erreurs.push(doc);
      continue;
    }
    if (!surChaquePr(doc) || !sansReglage(doc)) continue;
    if (Object.values(estObj(doc.jobs) ? doc.jobs : {}).some((job) => estObj(job) && jobLanceGarde(job))) trouve = true;
  }
  if (!trouve) erreurs.push("aucun workflow ne lance exactement « node scripts/garde-licences.ts » sur chaque PR, sans condition, tolérance ni réglage");
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
