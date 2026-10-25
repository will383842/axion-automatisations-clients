import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "js-yaml";

// Garde des workflows (C-528, C-529). Deux barrières : un vrai analyseur YAML pour les permissions, puis une lecture ligne à ligne. Aucun code exécuté.

const SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^docker:\/\/[^@]+@sha256:[0-9a-f]{64}$/;
const RUNS_ON = /^\s*runs-on:\s*["']?ubuntu-(?:latest|\d{2}\.\d{2})["']?\s*$/;
const DECLENCHEURS_RESERVES = new Set(["push", "schedule", "workflow_dispatch"]);

// Valeur acceptée derrière statuses: ou checks:, puis formes YAML qui masquent une valeur (ancre &, alias *, étiquette !, clé explicite ?, fusion <<).
const VALEUR_LECTURE = /^\s*["']?(?:read|none)["']?\s*(?:[,}]|$)/;
const STRUCTURE_YAML = /(?:^|[\s:[{,-])&[\w-]+|(?::|^\s*-|[[{,])\s*\*[\w-]+|(?::|^\s*-|[[{,])\s*!\S|^\s*\?(?:\s|$)|^\s*<<\s*:/;

// Coupe au premier « # » précédé d'une espace ou en début de ligne, hors d'une chaîne entre guillemets (une apostrophe au milieu d'un mot n'ouvre rien).
function sansCommentaire(ligne: string): string {
  let guillemet = "";
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne.charAt(i);
    const avant = i === 0 ? " " : ligne.charAt(i - 1);
    if (guillemet === '"') {
      if (c === "\\") i++;
      else if (c === '"') guillemet = "";
    } else if (guillemet === "'") {
      if (c === "'" && ligne.charAt(i + 1) === "'") i++;
      else if (c === "'") guillemet = "";
    } else if ((c === '"' || c === "'") && /[\s[{,:-]/.test(avant)) guillemet = c;
    else if (c === "#" && /\s/.test(avant)) return ligne.slice(0, i);
  }
  return ligne;
}

const LECTURE_SEULE = new Set(["read", "none"]);
const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Première barrière : le fichier est lu par un analyseur YAML, puis TOUTES les valeurs dont la clé vaut « permissions » sont contrôlées (fichier, jobs, flux, clés entre guillemets ou échappées).
function verifierPermissionsYaml(texte: string): string[] {
  let ancres = 0;
  let documents: unknown[];
  try {
    documents = loadAll(texte, null, { listener: (_e, etat) => { if (etat.anchor) ancres++; } });
  } catch {
    return ["YAML illisible : le workflow ne peut pas être contrôlé"];
  }
  const erreurs: string[] = [];
  if (ancres > 0) erreurs.push("ancre, alias ou fusion YAML interdits dans un workflow");
  const parcourir = (noeud: unknown): void => {
    if (Array.isArray(noeud)) return noeud.forEach(parcourir);
    if (!estObjet(noeud)) return;
    for (const [cle, valeur] of Object.entries(noeud)) {
      if (cle === "permissions") {
        if (estObjet(valeur)) {
          for (const [droit, niveau] of Object.entries(valeur)) {
            if (/^(statuses|checks)$/i.test(droit) && !(typeof niveau === "string" && LECTURE_SEULE.has(niveau))) {
              erreurs.push(`permission ${droit}: ${String(niveau)} interdite (seul read ou none est accepté)`);
            }
          }
        } else if (valeur !== "read-all") {
          erreurs.push("permissions: doit être un objet, read-all ou {} (write-all et les autres valeurs sont interdits)");
        }
      }
      parcourir(valeur);
    }
  };
  documents.forEach(parcourir);
  return erreurs;
}

// ADR 0014 : packages, id-token et attestations en écriture ouvrent la publication. Permis dans un seul endroit : jobs.publier de images-derivees.yml.
const DROITS_PUBLICATION = new Set(["packages", "id-token", "attestations"]);
function verifierEcrituresPaquets(nom: string, texte: string): string[] {
  let documents: unknown[];
  try {
    documents = loadAll(texte);
  } catch {
    return [];
  }
  const erreurs: string[] = [];
  const parcourir = (noeud: unknown, chemin: string[]): void => {
    if (Array.isArray(noeud)) return noeud.forEach((n, i) => parcourir(n, [...chemin, String(i)]));
    if (!estObjet(noeud)) return;
    for (const [cle, valeur] of Object.entries(noeud)) {
      if (cle === "permissions" && estObjet(valeur)) {
        const autorise = (nom === "images-derivees.yml" || nom === "images.yml") && chemin.join(".") === "jobs.publier";
        for (const [droit, niveau] of Object.entries(valeur)) {
          if (DROITS_PUBLICATION.has(droit.toLowerCase()) && !LECTURE_SEULE.has(String(niveau)) && !autorise) erreurs.push(`permission ${droit}: ${String(niveau)} interdite hors du job publier de images-derivees.yml`);
        }
      }
      parcourir(valeur, [...chemin, cle]);
    }
  };
  documents.forEach((d) => parcourir(d, []));
  return erreurs;
}

// T1A-16 : chaîne de déploiement protégée (C-388, C-391). Tout est lu sur l'arbre YAML, jamais par regex sur le YAML.
const ENV_RESERVES = /^(production|recette)$/i;
const SECRET_AUTRE = /\bsecrets\.(?!GITHUB_TOKEN\b)(\w+)/g;
const REF_MAIN = "github.ref == 'refs/heads/main'";
type Entree = [string[], unknown];
function entrees(noeud: unknown, chemin: string[] = []): Entree[] {
  if (Array.isArray(noeud)) return noeud.flatMap((n, i) => entrees(n, [...chemin, String(i)]));
  if (!estObjet(noeud)) return [];
  return Object.entries(noeud).flatMap(([c, v]): Entree[] => [[[...chemin, c], v], ...entrees(v, [...chemin, c])]);
}
const textes = (n: unknown): string[] => (typeof n === "string" ? [n] : Array.isArray(n) ? n.flatMap(textes) : estObjet(n) ? Object.values(n).flatMap(textes) : []);
const dans = (n: unknown, ...cles: string[]): unknown => cles.reduce<unknown>((x, c) => (estObjet(x) ? x[c] : undefined), n);

function verifierChaine(nom: string, texte: string): string[] {
  let documents: unknown[];
  try {
    documents = loadAll(texte);
  } catch {
    return [];
  }
  const doc = documents[0];
  if (!estObjet(doc)) return [];
  const erreurs: string[] = [];
  const tous = documents.flatMap((d) => entrees(d));
  const declencheur = doc.on;
  const noms = typeof declencheur === "string" ? [declencheur] : Array.isArray(declencheur) ? declencheur.map(String) : estObjet(declencheur) ? Object.keys(declencheur) : [];
  for (const [chemin, valeur] of tous) if (chemin.at(-1) === "secrets" && valeur === "inherit") erreurs.push("secrets: inherit interdit");

  if (nom !== "deploiement.yml") {
    if (/coolify/i.test(texte)) erreurs.push("COOLIFY réservé à deploiement.yml");
    if (/deploiement\.yml/.test(texte)) erreurs.push("seul un lancement manuel peut viser deploiement.yml");
    for (const [chemin, valeur] of tous) {
      if (chemin.at(-1) !== "environment") continue;
      const cible = estObjet(valeur) ? valeur.name : valeur;
      if (typeof cible !== "string" || ENV_RESERVES.test(cible.trim()) || cible.includes("${{")) erreurs.push("environment production, recette ou dynamique réservé à deploiement.yml");
    }
  }
  if (nom === "images.yml") {
    if (noms.some((n) => n !== "push" && n !== "pull_request")) erreurs.push("images.yml : seuls push sur main et pull_request sont permis");
    if (JSON.stringify(dans(declencheur, "push", "branches")) !== '["main"]') erreurs.push("images.yml : push limité à la branche main");
    for (const s of textes(doc).flatMap((x) => [...x.matchAll(SECRET_AUTRE)])) erreurs.push(`secrets.${s[1] ?? ""} interdit dans images.yml (seul GITHUB_TOKEN est permis)`);
    const garde = String(dans(doc, "jobs", "publier", "if") ?? "");
    if (!garde.includes("github.event_name == 'push'") || !garde.includes(REF_MAIN)) erreurs.push("job publier : garde « push sur main » absente");
  }
  if (nom !== "deploiement.yml") return erreurs;

  if (noms.length !== 1 || noms[0] !== "workflow_dispatch") erreurs.push("deploiement.yml : workflow_dispatch seulement");
  const entrees_ = dans(declencheur, "workflow_dispatch", "inputs");
  if (JSON.stringify([...((dans(entrees_, "cible", "options") as string[] | undefined) ?? [])].sort()) !== '["production","recette"]') erreurs.push("entrée cible : seulement recette et production");
  if (!estObjet(dans(entrees_, "empreinte"))) erreurs.push("entrée empreinte absente");
  for (const [chemin, valeur] of tous) if (chemin[0] !== "jobs" && textes(valeur).some((x) => x.includes("secrets."))) erreurs.push("secret hors d'un job interdit");
  const jobs = estObjet(doc.jobs) ? Object.entries(doc.jobs) : [];
  if (jobs.length === 0) erreurs.push("aucun job");
  for (const [id, job] of jobs) {
    if (!String(dans(job, "if") ?? "").includes(REF_MAIN)) erreurs.push(`job ${id} : if ${REF_MAIN} absent (refs/heads/main)`);
    if (dans(job, "environment") !== "${{ inputs.cible }}") erreurs.push(`job ${id} : environment doit être \${{ inputs.cible }}`);
    const etapes = Array.isArray(dans(job, "steps")) ? (dans(job, "steps") as unknown[]) : [];
    const premiere = etapes[0];
    if (!textes(dans(premiere, "env")).includes("${{ github.ref }}") || !String(dans(premiere, "run") ?? "").includes("refs/heads/main") || !String(dans(premiere, "run") ?? "").includes("exit 1")) erreurs.push(`job ${id} : première étape sans refus explicite hors refs/heads/main`);
    for (const etape of etapes) {
      const run = String(dans(etape, "run") ?? "");
      if (/^actions\/checkout@/.test(String(dans(etape, "uses") ?? ""))) erreurs.push("checkout interdit : le déploiement ne construit jamais de code");
      if (/\bdocker\s+(buildx\s+)?build\b/.test(run)) erreurs.push("docker build interdit : le déploiement ne construit jamais de code");
      if (run.includes("${{")) erreurs.push("run : expression ${{ }} interdite (passer par env)");
    }
    if (!etapes.some((e) => String(dans(e, "run") ?? "").includes("sha256:[0-9a-f]{64}"))) erreurs.push(`job ${id} : empreinte non validée (sha256:[0-9a-f]{64} exigé)`);
  }
  return erreurs;
}

function declencheurs(lignes: string[]): string[] {
  const i = lignes.findIndex((l) => /^["']?on["']?:/.test(l));
  if (i < 0) return [];
  const reste = (lignes[i] ?? "").replace(/^["']?on["']?:/, "").trim();
  if (reste) return reste.split(/[[\]{},:\s]+/).filter(Boolean);
  const noms: string[] = [];
  let indent = -1;
  for (const l of lignes.slice(i + 1)) {
    if (!l.trim()) continue;
    const marge = l.length - l.trimStart().length;
    if (marge === 0) break;
    if (indent < 0) indent = marge;
    if (marge !== indent) continue;
    const m = /^\s*(?:-\s*)?([a-z_]+)\s*:?/.exec(l);
    if (m?.[1]) noms.push(m[1]);
  }
  return noms;
}

export function verifierWorkflow(nom: string, texte: string): string[] {
  const lignes = texte.split("\n").map(sansCommentaire);
  const erreurs: string[] = [];
  const echec = (n: number, msg: string) => erreurs.push(`${nom}:${n}: ${msg}`);
  verifierPermissionsYaml(texte).forEach((msg) => echec(1, msg));
  verifierEcrituresPaquets(nom, texte).forEach((msg) => echec(1, msg));
  verifierChaine(nom, texte).forEach((msg) => echec(1, msg));
  const trigs = declencheurs(lignes);
  const surPr = trigs.includes("pull_request") || lignes.some((l) => /\bpull_request\b(?!_target)/.test(l));

  if (lignes.some((l) => /\bpull_request_target\b/.test(l))) echec(1, "pull_request_target est interdit");
  if (!lignes.some((l) => /^permissions:/.test(l))) echec(1, "bloc permissions absent en tête du fichier");

  lignes.forEach((l, idx) => {
    const n = idx + 1;
    if (/^\s*runs-on:.*self-hosted/.test(l) || (/self-hosted/.test(l) && /runs-on/.test(lignes[idx - 1] ?? ""))) {
      echec(n, "runs-on self-hosted est interdit");
    } else if (/^\s*runs-on:/.test(l) && !RUNS_ON.test(l)) {
      echec(n, "runs-on doit être un exécuteur hébergé par GitHub (ubuntu-latest ou ubuntu-NN.NN)");
    }
    // Liste blanche : une clé statuses ou checks n'est acceptée que si read ou none suit sur la même ligne (un faux statut « garde-fusion » serait possible sinon).
    for (const m of l.matchAll(/["']?\b(statuses|checks)["']?\s*:(.*)$/g)) {
      if (!VALEUR_LECTURE.test(m[2] ?? "")) echec(n, `permission ${m[1] ?? ""}: write interdite (seul read ou none, sur la même ligne, est accepté)`);
    }
    if (STRUCTURE_YAML.test(l)) echec(n, "ancre, alias, étiquette, clé explicite ou fusion YAML interdits dans un workflow");
    const perm = /^\s*permissions:(.*)$/.exec(l);
    if (perm) {
      const valeur = (perm[1] ?? "").trim();
      if (/^["']?write-all["']?$/.test(valeur)) echec(n, "permissions: write-all est interdit");
      else if (valeur === "" ? !/^\s+["']?[\w-]+["']?\s*:/.test(lignes.slice(idx + 1).find((x) => x.trim()) ?? "") : !/^(read-all|\{.*)$/.test(valeur)) {
        echec(n, "permissions: doit être un bloc, read-all ou {}");
      }
    }
    if (surPr) {
      // Un identifiant de job « secrets: » seul sur sa ligne n'expose rien.
      for (const m of /^\s*secrets:\s*$/.test(l) ? [] : l.matchAll(/\bsecrets\b(?!\.GITHUB_TOKEN\b)(\.\w+)?/g)) {
        if (/^\s*secrets:\s*inherit/.test(l)) echec(n, "secrets: inherit interdit dans un workflow pull_request");
        else echec(n, `secrets${m[1] ?? ""} interdit dans un workflow pull_request (seul secrets.GITHUB_TOKEN est permis)`);
      }
    }
    // Toute forme de « uses: » est lue : en bloc, entre accolades, valeur sur la ligne suivante ou scalaire multiligne.
    if (/\buses\s*:\s*$/.test(l) || /\buses\s*:\s*[>|]/.test(l)) echec(n, "uses: sur plusieurs lignes interdit");
    for (const u of l.matchAll(/\buses\s*:\s*["']?([^\s"'},>|]+)/g)) {
      const valeur = u[1] ?? "";
      if (valeur.startsWith("./")) continue;
      const ref = valeur.split("@")[1] ?? "";
      if (!SHA.test(ref) && !IMAGE.test(valeur)) echec(n, `action non épinglée par SHA : ${valeur}`);
    }
    if (/\buses\s*:\s*["']?actions\/checkout@/.test(l)) {
      let suite = idx + 1;
      while (suite < lignes.length && !/^\s*-\s/.test(lignes[suite] ?? "") && !/^\S/.test(lignes[suite] ?? "")) suite++;
      if (!lignes.slice(idx, suite).some((x) => /persist-credentials:\s*false/.test(x))) {
        echec(n, "actions/checkout sans persist-credentials: false");
      }
    }
    if (/^\s*environment:/.test(l)) {
      const hors = trigs.filter((t) => !DECLENCHEURS_RESERVES.has(t));
      const pushHorsMain = trigs.includes("push") && !lignes.some((x) => /branches:.*\bmain\b/.test(x));
      if (hors.length > 0 || pushHorsMain) {
        echec(n, "environment réservé aux workflows de main et planifiés");
      }
    }
  });
  return erreurs;
}

export function verifierDossier(dossier: string): string[] {
  return readdirSync(dossier)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => verifierWorkflow(f, readFileSync(join(dossier, f), "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = verifierDossier(process.argv[2] ?? ".github/workflows");
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
