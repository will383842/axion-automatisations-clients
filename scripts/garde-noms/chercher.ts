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
  const entiers = chercher(chemin.replace(/[\r\n]+/g, " "), noms); // un nom coupé par un séparateur
  return [...new Set([...chercher(chemin.replace(/[/\\]/g, "\n"), noms), ...entiers].map((t) => t.numero))];
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

// Refus de la garde qui n'est pas une trouvaille : code 1, message sans le nom ni les octets fautifs (C-531).
export class Refus extends Error {}

// Décodage UTF-8 STRICT (B6) : aucune partie de l'entrée n'est remplacée par U+FFFD, et NUL est refusé
// (sauf comme séparateur du mode « chemins »). Liste fermée : UTF-8 valide ou rien.
export function decoderUtf8(octets: Uint8Array, lieu: string, autoriserNul = false): string {
  const refus = new Refus(`encodage non UTF-8, lieu ${lieu} : convertir en UTF-8`);
  let texte: string;
  try {
    texte = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(octets);
  } catch {
    throw refus;
  }
  if (!autoriserNul && texte.includes("\0")) throw refus;
  return texte;
}

const git = (lieu: string, ...args: string[]): string =>
  decoderUtf8(execFileSync("git", ["-c", "core.quotePath=false", ...args], { maxBuffer: 256 * 1024 * 1024 }), lieu);

// Défait le C-quoting de git (guillemets, \\\\, \\", \\t, octal).
export function dequoter(brut: string): string {
  if (!(brut.length >= 2 && brut.startsWith('"') && brut.endsWith('"'))) return brut;
  const simples: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const octets: number[] = [];
  const corps = Buffer.from(brut.slice(1, -1), "utf8");
  for (let i = 0; i < corps.length; i++) {
    const c = corps[i] ?? 0;
    if (c !== 0x5c) {
      octets.push(c);
      continue;
    }
    const suite = String.fromCharCode(corps[i + 1] ?? 0);
    const octal = /^[0-7]{3}/.exec(corps.subarray(i + 1, i + 4).toString("latin1"));
    if (octal) {
      octets.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      octets.push(simples[suite] ?? corps[i + 1] ?? 0);
      i += 1;
    }
  }
  return Buffer.from(octets).toString("utf8");
}

// Lieu écrit pour un chemin de l'en-tête « +++ ». Dès que le chemin, brut (guillemets et barres obliques
// inverses compris) ou dé-quoté, contient un nom : jamais écrit, seulement « fichier masqué (n° k) » (C-531).
export function lieuDuFichier(enTete: string, liste: Liste): string {
  const brut = enTete.replace(/\t.*$/, ""); // git ajoute une tabulation après un chemin contenant une espace
  const propre = brut.replace(/^b\//, "");
  const sans = dequoter(brut).replace(/^b\//, "");
  const numeros = [...chercherNomDeFichier(brut, liste), ...chercherNomDeFichier(propre, liste), ...chercherNomDeFichier(sans, liste)];
  if (numeros.length > 0) return `fichier masqué (n° ${numeros[0]})`;
  return `fichier ${sans}`;
}

const dequoterTout = (texte: string): string => texte.replace(/"(?:[^"\\]|\\.)*"/g, (m) => dequoter(m));

// Numéros de liste trouvés dans un chemin tel qu'écrit par git : brut, sans la tabulation de fin, dé-quoté.
function numerosDuChemin(brut: string, liste: Liste): number[] {
  const sansTab = brut.replace(/\t.*$/, "");
  const candidats = [brut, sansTab, dequoterTout(sansTab)].map((c) => c.replace(/^(?:a|b)\//, ""));
  return [...new Set(candidats.flatMap((c) => chercherNomDeFichier(c, liste)))];
}

// Vérifie un diff unifié (git diff / git show, --unified=0). Pure : texte et liste en entrée, erreurs sans nom en sortie (C-531).
// Contrôle les lignes ajoutées (avec une fenêtre de 2 lignes ajoutées jointes : nom coupé en fin de ligne),
// les chemins nouveaux et renommés (anciens et nouveaux), et refuse un chemin échappé (\3xx).
export function verifierDiff(texteDiff: string, noms: Liste | string[]): string[] {
  const liste = asListe(noms);
  const erreurs: string[] = [];
  const vus = new Set<string>();
  const nomDeFichier = (brut: string): void => {
    for (const n of numerosDuChemin(brut, liste)) {
      const e = formaterNomDeFichier([n])[0] ?? "";
      if (!vus.has(e)) {
        vus.add(e);
        erreurs.push(e);
      }
    }
  };
  let lieu = "";
  let entete = false;
  let ligne = 0;
  let precedente: { texte: string; ligne: number; numeros: Set<number> } | null = null;
  for (const l of texteDiff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      entete = true;
      lieu = "";
      precedente = null;
      if (l.startsWith('diff --git "') && /\\[0-3][0-7]{2}/.test(l) && !vus.has("echappe")) {
        vus.add("echappe");
        erreurs.push("chemin échappé, relancer avec core.quotePath=false");
      }
      nomDeFichier(l.slice(11));
    } else if (entete && (l.startsWith("--- ") || l.startsWith("+++ "))) {
      const chemin = l.slice(4);
      if (!chemin.startsWith("/dev/null")) {
        nomDeFichier(chemin);
        if (l.startsWith("+++ ")) lieu = lieuDuFichier(chemin, liste);
      }
    } else if (entete && /^(?:rename|copy) (?:from|to) /.test(l)) {
      nomDeFichier(l.replace(/^(?:rename|copy) (?:from|to) /, ""));
    } else if (l.startsWith("@@")) {
      entete = false;
      precedente = null;
      ligne = Number(/\+(\d+)/.exec(l)?.[1] ?? 1) - 1;
    } else if (!entete && l.startsWith("+")) {
      ligne++;
      const texte = l.slice(1);
      const trouves = chercher(texte, liste);
      const numeros = new Set(trouves.map((t) => t.numero));
      for (const t of trouves) erreurs.push(`nom interdit, ${lieu}, ligne ${ligne} (n° ${t.numero})`);
      if (precedente && precedente.ligne === ligne - 1) {
        for (const t of chercher(`${precedente.texte} ${texte}`, liste)) {
          if (!precedente.numeros.has(t.numero) && !numeros.has(t.numero)) erreurs.push(`nom interdit, ${lieu}, ligne ${ligne} (n° ${t.numero})`);
        }
      }
      precedente = { texte, ligne, numeros };
    }
  }
  return erreurs;
}

export const verifierIndex = (liste: Liste): string[] =>
  verifierDiff(git("index", "diff", "--cached", "-M", "--unified=0", "--no-color", "--diff-filter=ACMR"), liste);

// Mode « chemins » : entrées séparées par NUL (sorties -z de git), jamais lues dans les lignes « diff --git ».
export function verifierChemins(octets: Uint8Array, lieu: string, liste: Liste): string[] {
  const champs = decoderUtf8(octets, lieu, true).split("\0");
  if (champs[champs.length - 1] === "") champs.pop();
  if (champs.some((c) => c === "")) throw new Refus(`chemins mal formés (champ vide), lieu ${lieu}`);
  const erreurs: string[] = [];
  champs.forEach((c, i) => {
    for (const n of chercherNomDeFichier(c, liste)) erreurs.push(`nom de fichier interdit, ${lieu}, entrée ${i + 1} (n° ${n})`);
  });
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
    const messages = git("pousse", "log", "--format=%H%x1f%B%x1e", ...plage).split("\x1e").map((m) => m.trim()).filter(Boolean);
    for (const m of messages) {
      const [sha = "", corps = ""] = m.split("\x1f");
      for (const t of chercher(corps, liste)) erreurs.push(`nom interdit, message du commit ${sha.slice(0, 7)}, ligne ${t.ligne}`);
    }
  }
  return erreurs;
}

// Codes de sortie : 0 propre ; 1 refus sans trouvaille (liste absente, encodage non UTF-8, entrée mal formée) ;
// 2 nom trouvé (modes diff, texte, chemins) ; 64 mauvais appel. Les crochets (pre-commit, pre-push) sortent 1 sur une trouvaille.
function main(mode: string, arg: string | undefined): number {
  const { liste, refus, avertissement } = chargerListe(process.env);
  if (refus) {
    console.error(refus);
    return 1;
  }
  const modesDeFusion = ["diff", "texte", "chemins"];
  if (avertissement) {
    if (!modesDeFusion.includes(mode)) {
      console.error(avertissement);
      return 0;
    }
    console.error("NOMS_CLIENTS absente : refus (échec fermé).");
    return 1;
  }
  const lieu = arg ?? mode;
  let erreurs: string[];
  let trouvaille = 1;
  try {
    if (mode === "pre-commit") erreurs = verifierIndex(liste);
    else if (mode === "pre-push") erreurs = verifierPoussee(decoderUtf8(readFileSync(0), "poussée"), liste);
    else if (mode === "texte") {
      trouvaille = 2;
      erreurs = formaterTrouvailles(lieu, chercher(decoderUtf8(readFileSync(0), lieu), liste));
    } else if (mode === "diff") {
      trouvaille = 2;
      erreurs = verifierDiff(decoderUtf8(readFileSync(0), lieu), liste).map((e) => `${lieu} : ${e}`);
    } else if (mode === "chemins") {
      trouvaille = 2;
      erreurs = verifierChemins(readFileSync(0), lieu, liste);
    } else {
      console.error("usage : chercher.ts pre-commit | pre-push | texte <lieu> | diff <lieu> | chemins <lieu>");
      return 64;
    }
  } catch (e) {
    if (e instanceof Refus) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  for (const e of erreurs) console.error(e);
  return erreurs.length ? trouvaille : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2] ?? "", process.argv[3]));
