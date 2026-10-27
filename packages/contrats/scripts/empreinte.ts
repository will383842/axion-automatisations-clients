import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRATS } from "./versions.ts";

// Empreintes de contrats (ADR 0019, revu par l'ADR 0031) :
// - empreintes/<contrat>.sha256 : un SHA-256 par fichier de fixtures/<contrat>/, au format de sha256sum. C'est ce que
//   l'autre dépôt copie et compare (`sha256sum --check`). Le code source n'y entre pas : ce qui passe le fil (JSON Schema,
//   constantes, invariants) est généré dans fixtures/ et un test vérifie qu'il suit le code.
// - contrats.sha256 : le sommaire, une ligne par fichier d'empreintes (commun et C5 compris) et une pour VERSION.
const DOSSIERS_SOMMAIRE = ["empreintes"];

function fichiers(racine: string, dossier: string): string[] {
  if (!existsSync(`${racine}/${dossier}`)) return [];
  return readdirSync(`${racine}/${dossier}`, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? fichiers(racine, `${dossier}/${e.name}`) : [`${dossier}/${e.name}`]))
    .sort();
}

const ligne = (racine: string, f: string) => `${createHash("sha256").update(readFileSync(`${racine}/${f}`)).digest("hex")}  ${f}\n`;

export function calculerEmpreintes(racine: string): Record<string, string> {
  return Object.fromEntries(CONTRATS.map((c) => [c, fichiers(racine, `fixtures/${c}`).map((f) => ligne(racine, f)).join("")]));
}

// Sommaire calculé sur les fichiers d'empreintes tels qu'ils sont sur le disque, puis VERSION.
export function calculerSommaire(racine: string): string {
  return [...DOSSIERS_SOMMAIRE.flatMap((d) => fichiers(racine, d)), "VERSION"].map((f) => ligne(racine, f)).join("");
}

// Usage : node scripts/empreinte.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const racine = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(`${racine}/empreintes`, { recursive: true });
  for (const [c, texte] of Object.entries(calculerEmpreintes(racine))) writeFileSync(`${racine}/empreintes/${c}.sha256`, texte);
  writeFileSync(`${racine}/contrats.sha256`, calculerSommaire(racine));
}
