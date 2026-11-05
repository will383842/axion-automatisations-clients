import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Preuves et dettes : un fichier par fiche (ADR 0029, mise à jour du 05/11/2026).
// `spec/preuves.md` est l'historique, figé par convention ; chaque PR ajoute UN fichier neuf `spec/preuves/<branche-assainie>.md`.
// Deux PR n'écrivent donc jamais le même fichier : GitHub ne voit plus de conflit. Tout lecteur passe par agregerPreuves.

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const HISTORIQUE = "spec/preuves.md";
const DOSSIER = "spec/preuves";
const NOM_VALIDE = /^[a-z0-9][a-z0-9.-]*\.md$/;

const fichiersDuDossier = (racine: string) =>
  existsSync(join(racine, DOSSIER))
    ? readdirSync(join(racine, DOSSIER), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name !== "README.md")
        .map((e) => e.name)
    : [];

// Historique d'abord, puis les fichiers de spec/preuves/ dans l'ordre des noms (code des caractères, indépendant de la langue du poste).
export function agregerPreuves(racine = RACINE): string {
  const morceaux: string[] = [];
  if (existsSync(join(racine, HISTORIQUE))) morceaux.push(readFileSync(join(racine, HISTORIQUE), "utf8"));
  for (const nom of fichiersDuDossier(racine).filter((n) => n.endsWith(".md")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    morceaux.push(readFileSync(join(racine, DOSSIER, nom), "utf8"));
  }
  return morceaux.map((m) => m.trimEnd()).filter(Boolean).map((m) => `${m}\n`).join("");
}

// Nom du fichier de preuves d'une branche : minuscules, tout autre caractère que [a-z0-9] devient un tiret.
export function fichierPreuvesDeBranche(branche: string): string {
  const nom = branche.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!nom) throw new Error(`branche sans nom utilisable : ${branche}`);
  return `${DOSSIER}/${nom}.md`;
}

export function verifierDossierPreuves(racine = RACINE): string[] {
  return fichiersDuDossier(racine)
    .filter((n) => !NOM_VALIDE.test(n))
    .sort()
    .map((n) => `${DOSSIER}/${n} : nom non assaini`);
}

// Garde : un appel de lecture (readFileSync, existsSync, lire…, URL, cat…) dont le premier argument est le chemin de l'historique. Commentaires ignorés.
// Limite : motif non exhaustif (chemin construit en morceaux, autre nom de fonction) ; un chemin vers un dépôt jetable (join(d, …)) n'est pas visé.
const LECTURE_DIRECTE = /(?:\b(?:readFileSync|readFile|existsSync|statSync|createReadStream|lire\w*|URL)\(\s*["'`](?:\.{1,2}\/)*|\b(?:cat|grep[^|;]*)\s+(?:\.{1,2}\/)*)spec\/preuves\.md\b/;
export function consommateursDirects(source: string): string[] {
  return source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
    .filter((l) => LECTURE_DIRECTE.test(l))
    .map((l) => l.trim());
}

// Usage : node scripts/agreger-preuves.ts > agregat.md (sortie standard, aucun fichier écrit).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = verifierDossierPreuves();
  for (const e of erreurs) console.error(e);
  process.stdout.write(agregerPreuves());
  process.exit(erreurs.length ? 1 : 0);
}
