import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Garde des données réelles (C-532, C-390, C-378). La sortie ne contient JAMAIS la valeur trouvée : « type, fichier, ligne ».

export type Trouvaille = { type: "extrait Sirene" | "e-mail" | "registre public"; fichier: string; ligne: number };

// Les fixtures de la garde elle-même sont exclues d'elle-même (pas du scan des secrets).
const EXCLUS = /^scripts\/__fixtures__\/donnees-reelles\//;
const NOM_EXTRAIT = /StockUniteLegale|StockEtablissement|\.parquet$/i;
const ENTETE_EXTRAIT = /^\uFEFF?["']?(?:siren|siret)["']?\s*;/i;
const PERIMETRE_COURRIEL = /(?:^|\/)(?:__)?fixtures(?:__)?\/|\.test\.ts$|^packages\/donnees-fictives\//;
const PERIMETRE_REGISTRE = /(?:^|\/)(?:__)?fixtures(?:__)?\/|\.test\.ts$|^packages\/harnais\//;
const COURRIEL = /[\w.%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const REGISTRE = /api\.insee\.fr|recherche-entreprises\.api\.gouv\.fr|annuaire-entreprises\.data\.gouv\.fr|entreprise\.data\.gouv\.fr/i;

const courrielPermis = (domaine: string): boolean => /^exemple\.(?:fr|com)$|\.test$/i.test(domaine);

export function scannerDepot(racine: string, fichiers: string[]): Trouvaille[] {
  const trouvailles: Trouvaille[] = [];
  for (const fichier of fichiers.filter((f) => !EXCLUS.test(f))) {
    const nomFichier = fichier.split("/").pop() ?? fichier;
    if (NOM_EXTRAIT.test(nomFichier)) {
      trouvailles.push({ type: "extrait Sirene", fichier, ligne: 0 });
      continue;
    }
    const lignes = readFileSync(join(racine, fichier), "utf8").split(/\r?\n/);
    if (ENTETE_EXTRAIT.test(lignes[0] ?? "")) {
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
