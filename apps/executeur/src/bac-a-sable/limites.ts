export interface Limites {
  // Plafond du tas de l'enfant (--max-old-space-size) : un dépassement tue l'enfant, jamais le parent.
  memoireMo: number;
  // Durée maximale d'une exécution ; au-delà l'enfant est tué (SIGKILL).
  dureeMs: number;
}

export const LIMITES_DEFAUT: Limites = { memoireMo: 128, dureeMs: 30_000 };

// Modèle de permissions de Node 22 : aucune écriture, aucun processus, aucun worker, lecture du seul fichier d'amorce.
// Pas de permission réseau en Node 22 : l'amorce coupe le réseau en profondeur, la frontière réelle est le réseau de l'image (étape 2).
export function argumentsEnfant(amorce: string, limites: Limites): string[] {
  return ["--experimental-permission", `--allow-fs-read=${amorce}`, `--max-old-space-size=${limites.memoireMo}`, "--disallow-code-generation-from-strings", amorce];
}
