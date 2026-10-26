import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Empreintes de contrats : un fichier empreintes/<contrat>.sha256 par contrat (un SHA-256 par fichier, au format de sha256sum),
// pour que deux PR sur deux contrats différents ne se touchent pas (ADR 0019).
const CONTRATS = ["c1", "c2", "c3", "c4", "c6"];
const DOSSIERS = ["fixtures", "src"];

function fichiers(racine: string, dossier: string): string[] {
  if (!existsSync(`${racine}/${dossier}`)) return [];
  return readdirSync(`${racine}/${dossier}`, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? fichiers(racine, `${dossier}/${e.name}`) : [`${dossier}/${e.name}`]))
    .sort();
}

// Ensemble des fichiers couverts avant le découpage : fixtures/ en entier, src/c1 et src/c2.
const couvert = (f: string) => f.startsWith("fixtures/") || f.startsWith("src/c1/") || f.startsWith("src/c2/");

export function calculerEmpreintes(racine: string): Record<string, string> {
  return Object.fromEntries(
    CONTRATS.map((c) => [
      c,
      DOSSIERS.flatMap((d) => fichiers(racine, `${d}/${c}`))
        .filter(couvert)
        .map((f) => `${createHash("sha256").update(readFileSync(`${racine}/${f}`)).digest("hex")}  ${f}\n`)
        .join(""),
    ]),
  );
}

// Usage : node scripts/empreinte.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const racine = fileURLToPath(new URL("../", import.meta.url));
  rmSync(`${racine}/contrats.sha256`, { force: true });
  mkdirSync(`${racine}/empreintes`, { recursive: true });
  for (const [c, texte] of Object.entries(calculerEmpreintes(racine))) writeFileSync(`${racine}/empreintes/${c}.sha256`, texte);
}
