import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

// Garde des licences : liste fermée. MPL-2.0 seulement dans ce qui n'est jamais livré (apps/api, apps/console, apps/portail) ;
// ce qui est livré chez un client n'a droit qu'aux six licences du livre (A-375, ADR 0009).

export const LIVRE = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "PostgreSQL"]);
const PERMISES = new Set([...LIVRE, "0BSD", "OFL-1.1"]);
const MPL = "MPL-2.0";

// Exceptions NOMMÉES (paquet + licence), réservées aux dépendances de développement (ADR 0007, ADR 0008).
const EXCEPTIONS_DEV: Record<string, string> = { argparse: "Python-2.0", minimatch: "BlueOak-1.0.0", nodemailer: "MIT-0" };

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

function installOk(mots: string[]): string | undefined {
  const i = outil(mots);
  const nom = (mots[i] ?? "").split("/").pop() ?? "";
  const reste = mots.slice(i + 1);
  if ((nom === "bash" || nom === "sh") && reste[0] === "-c") return (commandes(reste[1] ?? "").map((c) => installOk(c.mots)).find(Boolean));
  if (nom === "pnpm") {
    let verbe = "";
    for (let k = 0; k < reste.length; k++) {
      const m = reste[k] ?? "";
      if (["--filter", "-F", "--dir", "-C"].includes(m)) k++;
      else if (!m.startsWith("-")) {
        verbe = m;
        break;
      }
    }
    if (["add", "update", "up", "upgrade", "dedupe", "link", "remove", "rm"].includes(verbe)) return `« pnpm ${verbe} » modifie le verrou`;
    if (verbe !== "install" && verbe !== "i") return undefined;
    if (reste.some((m) => /^--no-frozen-lockfile$|^--frozen-lockfile=(?!true$)/.test(m)) || !reste.some((m) => FIGE.test(m))) return "pnpm install sans --frozen-lockfile";
    return undefined;
  }
  if (nom === "npm") return ["install", "i", "add", "update", "install-test", "it"].includes(reste.find((m) => !m.startsWith("-")) ?? "") ? "npm install sans verrou (utiliser npm ci)" : undefined;
  if (nom === "yarn" || nom === "bun") {
    const verbe = reste.find((m) => !m.startsWith("-")) ?? "install";
    if (verbe === "add" || verbe === "upgrade") return `« ${nom} ${verbe} » modifie le verrou`;
    return verbe === "install" && !reste.some((m) => m === "--frozen-lockfile" || m === "--immutable") ? `${nom} install sans verrou figé` : undefined;
  }
  return undefined;
}

const etapes = (doc: Obj): { job: Obj; etape: Obj }[] =>
  Object.values(estObj(doc.jobs) ? doc.jobs : {}).flatMap((job) => (estObj(job) && Array.isArray(job.steps) ? job.steps.filter(estObj).map((etape) => ({ job, etape })) : []));

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
      if (typeof etape.uses === "string" && /^pnpm\/action-setup@/.test(etape.uses)) {
        const run = estObj(etape.with) ? etape.with.run_install : undefined;
        if (run !== undefined && run !== false && run !== "false") erreurs.push(`${f.nom} : pnpm/action-setup run_install doit rester faux`);
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

// C-019 : un job sans condition lance la garde des licences à chaque PR, sans que son échec soit toléré.
export function verifierWorkflowsLicences(workflows: Fichier[]): string[] {
  const erreurs: string[] = [];
  let trouve = false;
  for (const f of workflows) {
    const doc = lireWorkflow(f);
    if (typeof doc === "string") {
      erreurs.push(doc);
      continue;
    }
    if (!surChaquePr(doc)) continue;
    for (const { job, etape } of etapes(doc)) {
      if (job.if !== undefined || job["continue-on-error"] !== undefined || etape.if !== undefined || etape["continue-on-error"] !== undefined) continue;
      if (typeof etape.run === "string" && commandes(etape.run).some((c) => !c.tolere && c.mots[0] === "node" && c.mots.includes("scripts/garde-licences.ts"))) trouve = true;
    }
  }
  if (!trouve) erreurs.push("aucun workflow ne lance scripts/garde-licences.ts sur chaque PR, sans condition ni tolérance");
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
  const erreurs = [
    ...verifierLicences(lister(), nomsMpl, nomsProduction, nomsLivres),
    ...verifierLicencesLivrees(livres, "apps/executeur, sdk-module, connecteurs, modules"),
    ...verifierWorkflowsLicences(workflows),
    ...verifierInstallationsFigees(workflows),
  ];
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
