import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Garde des données réelles (C-532, C-390, C-378). La sortie ne contient JAMAIS la valeur trouvée : « type, fichier, ligne ».

export type Trouvaille = { type: "extrait Sirene" | "e-mail" | "registre public"; fichier: string; ligne: number };

// Les fixtures de la garde elle-même sont exclues d'elle-même (pas du scan des secrets).
const EXCLUS = /^scripts\/__fixtures__\/donnees-reelles\//;
const NOM_EXTRAIT = /StockUniteLegale|StockEtablissement|\.parquet$/i;
const COLONNES_EXTRAIT = /^(?:siren|siret)$/i;
// Dossier des mauvais exemples de la garde : exempt, mais seulement pour de petits fichiers texte.
const TAILLE_MAX_EXCLUS = 8192;
const ARCHIVE = /\.(?:zip|gz|tgz|7z|tar|bz2|xz|rar)$/i;
const PERIMETRE_TESTS = /(?:^|\/)(?:__)?fixtures?(?:__)?\/|\.(?:test|spec)\.tsx?$|^tests\//;
const PERIMETRE_COURRIEL = new RegExp(`${PERIMETRE_TESTS.source}|^packages/donnees-fictives/`);
const PERIMETRE_REGISTRE = new RegExp(`${PERIMETRE_TESTS.source}|^packages/harnais/`);
const COURRIEL = /[\w.%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const REGISTRE = /api\.insee\.fr|recherche-entreprises\.api\.gouv\.fr|annuaire-entreprises\.data\.gouv\.fr|entreprise\.data\.gouv\.fr|entreprise\.api\.gouv\.fr|files\.data\.gouv\.fr|registre-national-entreprises\.inpi\.fr/i;

const courrielPermis = (domaine: string): boolean => /^exemple\.(?:fr|com)$|\.test$/i.test(domaine);

export function scannerDepot(racine: string, fichiers: string[]): Trouvaille[] {
  const trouvailles: Trouvaille[] = [];
  for (const fichier of fichiers) {
    if (EXCLUS.test(fichier)) {
      if (ARCHIVE.test(fichier) || statSync(join(racine, fichier)).size > TAILLE_MAX_EXCLUS) trouvailles.push({ type: "extrait Sirene", fichier, ligne: 0 });
      continue;
    }
    const nomFichier = fichier.split("/").pop() ?? fichier;
    if (NOM_EXTRAIT.test(nomFichier)) {
      trouvailles.push({ type: "extrait Sirene", fichier, ligne: 0 });
      continue;
    }
    const lignes = readFileSync(join(racine, fichier), "utf8").split(/\r?\n/);
    if ((lignes[0] ?? "").replace(/^\uFEFF/, "").split(/[;,\t]/).some((c) => COLONNES_EXTRAIT.test(c.trim().replace(/^["']|["']$/g, "")))) {
      trouvailles.push({ type: "extrait Sirene", fichier, ligne: 1 });
      continue;
    }
    lignes.forEach((l, i) => {
      if (PERIMETRE_COURRIEL.test(fichier) && [...l.matchAll(COURRIEL)].some((m) => !courrielPermis(m[1] ?? ""))) {
        trouvailles.push({ type: "e-mail", fichier, ligne: i + 1 });
      }
      if (PERIMETRE_REGISTRE.test(fichier) && REGISTRE.test(l)) trouvailles.push({ type: "registre public", fichier, ligne: i + 1 });
    });
  }
  return trouvailles;
}

export const formaterTrouvailles = (trouvailles: Trouvaille[]): string[] => trouvailles.map((t) => `${t.type}, ${t.fichier}, ligne ${t.ligne}`);

// Usage : node scripts/garde-donnees-reelles.ts (depuis la racine du dépôt)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const liste = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const trouvailles = scannerDepot(".", liste.split("\0").filter(Boolean));
  for (const l of formaterTrouvailles(trouvailles)) console.error(l);
  process.exit(trouvailles.length ? 1 : 0);
}
