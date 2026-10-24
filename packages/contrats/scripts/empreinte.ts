import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Empreinte de contrats.sha256 : un SHA-256 par fichier de fixtures/, src/c1 et src/c2, au format de sha256sum.
const DOSSIERS = ["fixtures", "src/c1", "src/c2"];

function fichiers(racine: string, dossier: string): string[] {
  return readdirSync(`${racine}/${dossier}`, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? fichiers(racine, `${dossier}/${e.name}`) : [`${dossier}/${e.name}`]))
    .sort();
}

export function calculerEmpreinte(racine: string): string {
  return DOSSIERS.flatMap((d) => fichiers(racine, d))
    .map((f) => `${createHash("sha256").update(readFileSync(`${racine}/${f}`)).digest("hex")}  ${f}\n`)
    .join("");
}

// Usage : node scripts/empreinte.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const racine = fileURLToPath(new URL("../", import.meta.url));
  writeFileSync(`${racine}/contrats.sha256`, calculerEmpreinte(racine));
}
