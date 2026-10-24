// Normalisation commune de la garde des noms de clients (C-611).
// NFKD, accents retirés, minuscules, tout ce qui n'est ni lettre ni chiffre devient une espace.

const FORMES_JURIDIQUES = new Set(["sas", "sarl", "eurl", "sa", "sci", "selarl"]);

export function normaliser(texte: string): string {
  return texte
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Une entrée de la liste : formes juridiques retirées (mots entiers seulement).
export function normaliserEntree(entree: string): string {
  return normaliser(entree)
    .split(" ")
    .filter((mot) => mot !== "" && !FORMES_JURIDIQUES.has(mot))
    .join(" ");
}

export const sansEspaces = (texte: string): string => texte.replace(/ /g, "");
