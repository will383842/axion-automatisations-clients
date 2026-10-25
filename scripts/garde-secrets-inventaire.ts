import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Garde de l'inventaire des secrets (A-115). Elle lit des NOMS de variables, jamais des valeurs, et n'en affiche aucune.

export type Ligne = { nom: string; categorie: string; lieu: string };
const CATEGORIES = new Set(["equipe", "client", "construction", "production", "aucun"]);

// Lignes de tableau « | `NOM` | catégorie | lieu | rotation | ».
export function lireInventaire(texte: string): Ligne[] {
  return texte.split("\n").flatMap((l) => {
    const m = /^\|\s*`([A-Za-z0-9_./<>-]+)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(l);
    return m ? [{ nom: m[1] ?? "", categorie: m[2] ?? "", lieu: m[3] ?? "" }] : [];
  });
}

export function verifierInventaire(inventaire: Ligne[], lues: string[]): string[] {
  const erreurs: string[] = [];
  const inscrits = new Set(inventaire.map((l) => l.nom));
  for (const nom of lues) if (!inscrits.has(nom)) erreurs.push(`${nom} : variable lue mais non inscrite à ops/secrets-inventaire.md`);
  for (const { nom, categorie, lieu } of inventaire) {
    if (!CATEGORIES.has(categorie)) erreurs.push(`${nom} : catégorie « ${categorie} » inconnue`);
    if (categorie === "equipe" && /clients\//.test(lieu)) erreurs.push(`${nom} : un secret d'équipe ne se range jamais sous clients/`);
  }
  return erreurs;
}

const VARIABLE = /^[A-Z][A-Z0-9_]+$/;

// Variables lues : clés du schéma et accès à l'environnement des apps/*/src/config.ts, références ${VAR} des fragments ops/socle/compose.*.yml.
export function variablesLues(racine: string): string[] {
  const noms = new Set<string>();
  const dossiers = readdirSync(join(racine, "apps"), { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dossiers) {
    let texte = "";
    try {
      texte = readFileSync(join(racine, "apps", d.name, "src/config.ts"), "utf8");
    } catch {
      continue;
    }
    for (const m of texte.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*\S/gm)) noms.add(m[1] ?? "");
    for (const m of texte.matchAll(/env\["([A-Z0-9_]+)"\]|process\.env\.([A-Z0-9_]+)/g)) noms.add(m[1] ?? m[2] ?? "");
  }
  const socle = join(racine, "ops/socle");
  for (const f of readdirSync(socle).filter((n) => /^compose\..*\.yml$/.test(n))) {
    for (const m of readFileSync(join(socle, f), "utf8").matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) noms.add(m[1] ?? "");
  }
  return [...noms].filter((n) => VARIABLE.test(n)).sort();
}

// Usage : node scripts/garde-secrets-inventaire.ts (depuis la racine du dépôt)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = verifierInventaire(lireInventaire(readFileSync("ops/secrets-inventaire.md", "utf8")), variablesLues("."));
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
