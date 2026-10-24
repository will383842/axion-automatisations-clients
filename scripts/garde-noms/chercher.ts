import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error TS5097 : l'extension .ts est nécessaire pour lancer ce fichier directement avec Node.
import { normaliser, normaliserEntree, sansEspaces } from "./normaliser.ts";

// Garde des noms de clients, côté poste (C-611). La liste vient de la variable NOMS_CLIENTS
// (un nom par ligne ou séparés par « ; ») : jamais d'un fichier du dépôt.
// La sortie ne contient JAMAIS le nom trouvé, seulement un lieu et le numéro de l'entrée (C-531).

export type Trouvaille = { ligne: number; numero: number };
export type Liste = { numero: number; mots: string; colle: string }[];

export function parserListe(brut: string): Liste {
  const liste: Liste = [];
  brut.split(/[\n;]/).forEach((entree, i) => {
    const mots = normaliserEntree(entree);
    if (mots !== "") liste.push({ numero: i + 1, mots, colle: sansEspaces(mots) });
  });
  return liste;
}

const asListe = (liste: Liste | string[]): Liste =>
  liste.length > 0 && typeof liste[0] === "string" ? parserListe((liste as string[]).join("\n")) : (liste as Liste);

// Mots entiers sur le texte normalisé, ET sous-chaîne sur sa forme sans espaces (nom collé).
export function chercher(texte: string, noms: Liste | string[]): Trouvaille[] {
  const liste = asListe(noms);
  const trouvailles: Trouvaille[] = [];
  texte.split(/\r?\n/).forEach((brut, i) => {
    const mots = normaliser(brut);
    const colle = sansEspaces(mots);
    for (const e of liste) {
      if (` ${mots} `.includes(` ${e.mots} `) || colle.includes(e.colle)) trouvailles.push({ ligne: i + 1, numero: e.numero });
    }
  });
  return trouvailles;
}

export function chercherNomDeFichier(chemin: string, noms: Liste | string[]): number[] {
  return chercher(chemin.replace(/[/\\]/g, "\n"), noms).map((t) => t.numero);
}

export const formaterTrouvailles = (lieu: string, trouvailles: Trouvaille[]): string[] =>
  trouvailles.map((t) => `nom interdit, ${lieu}, ligne ${t.ligne}`);

export const formaterNomDeFichier = (numeros: number[]): string[] =>
  numeros.map((n) => `nom de fichier interdit (n° ${n})`);

// Échec fermé : liste absente + AXION_ROUTINE=1 → refus. Hors routine, un poste sans liste passe avec un avertissement.
export type Chargement = { liste: Liste; refus?: string; avertissement?: string };
export function chargerListe(env: Record<string, string | undefined>): Chargement {
  const liste = parserListe(env["NOMS_CLIENTS"] ?? "");
  if (liste.length > 0) return { liste };
  if (env["AXION_ROUTINE"] === "1") return { liste, refus: "NOMS_CLIENTS absente : refus (échec fermé)." };
  return { liste, avertissement: "NOMS_CLIENTS absente : garde des noms non appliquée sur ce poste." };
}

const git = (...args: string[]): string => execFileSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export function verifierIndex(liste: Liste): string[] {
  const erreurs: string[] = [];
  const fichiers = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean);
  // Un chemin qui contient déjà un nom n'est jamais écrit : « fichier masqué (n° k) ».
  const masques = new Map<string, number>();
  for (const f of fichiers) {
    const numeros = chercherNomDeFichier(f, liste);
    if (numeros.length > 0) {
      masques.set(f, numeros[0] ?? 0);
      erreurs.push(...formaterNomDeFichier(numeros));
    }
  }
  // Lignes ajoutées seulement. « +++ » n'est un en-tête qu'avant le premier « @@ » du fichier :
  // une ligne ajoutée « ++ x » s'écrit aussi « +++ x ».
  let fichier = "";
  let entete = false;
  let ligne = 0;
  for (const l of git("diff", "--cached", "--unified=0", "--no-color", "--diff-filter=ACMR").split("\n")) {
    if (l.startsWith("diff --git ")) entete = true;
    else if (entete && l.startsWith("+++ ")) fichier = l.slice(6);
    else if (l.startsWith("@@")) {
      entete = false;
      ligne = Number(/\+(\d+)/.exec(l)?.[1] ?? 1) - 1;
    } else if (!entete && l.startsWith("+")) {
      ligne++;
      const lieu = masques.has(fichier) ? `fichier masqué (n° ${masques.get(fichier)})` : `fichier ${fichier}`;
      for (const t of chercher(l.slice(1), liste)) erreurs.push(`nom interdit, ${lieu}, ligne ${ligne} (n° ${t.numero})`);
    }
  }
  return erreurs;
}

// Entrée standard d'un crochet pre-push : « réf-locale sha-local réf-distante sha-distant » par ligne.
export function verifierPoussee(entree: string, liste: Liste): string[] {
  const erreurs: string[] = [];
  const NUL = /^0+$/;
  for (const ligne of entree.split("\n").filter(Boolean)) {
    const [refLocale = "", shaLocal = "", refDistante = "", shaDistant = ""] = ligne.split(" ");
    if (NUL.test(shaLocal)) continue;
    if (chercher(refDistante, liste).length > 0 || chercher(refLocale, liste).length > 0) erreurs.push("nom interdit, nom de branche");
    const plage = NUL.test(shaDistant) ? [shaLocal, "--not", "--remotes"] : [`${shaDistant}..${shaLocal}`];
    const messages = git("log", "--format=%H%x1f%B%x1e", ...plage).split("\x1e").map((m) => m.trim()).filter(Boolean);
    for (const m of messages) {
      const [sha = "", corps = ""] = m.split("\x1f");
      for (const t of chercher(corps, liste)) erreurs.push(`nom interdit, message du commit ${sha.slice(0, 7)}, ligne ${t.ligne}`);
    }
  }
  return erreurs;
}

function main(mode: string, arg: string | undefined): number {
  const { liste, refus, avertissement } = chargerListe(process.env);
  if (refus) {
    console.error(refus);
    return 1;
  }
  if (avertissement) {
    console.error(avertissement);
    return 0;
  }
  let erreurs: string[];
  if (mode === "pre-commit") erreurs = verifierIndex(liste);
  else if (mode === "pre-push") erreurs = verifierPoussee(readFileSync(0, "utf8"), liste);
  else if (mode === "texte") erreurs = formaterTrouvailles(arg ?? "texte", chercher(readFileSync(0, "utf8"), liste));
  else {
    console.error("usage : chercher.ts pre-commit | pre-push | texte <lieu>");
    return 2;
  }
  for (const e of erreurs) console.error(e);
  return erreurs.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2] ?? "", process.argv[3]));
