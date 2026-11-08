import type { LigneCatalogue } from "./filtres.js";
import { normaliser } from "./recherche.js";

// Signal de doublon (B-534, V1) : similarité simple, sans IA. Ne bloque JAMAIS : le résultat ne sert qu'à demander « nouvelle automatisation ou préréglage d'une existante ? ».
export interface CandidatDoublon { nom: string; postes: string[]; metiers: string[]; outils: string[] }
export interface Proche { id: string; code: string; nom: string; score: number }
export const SEUIL_DOUBLON = 0.5;
const MAX_PROCHES = 5;

const mots = (texte: string): Set<string> => new Set(normaliser(texte).split(" ").filter((m) => m.length >= 3));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let commun = 0;
  for (const m of a) if (b.has(m)) commun++;
  return commun / (a.size + b.size - commun);
}
const etiquettes = (postes: string[], metiers: string[], outils: string[]): Set<string> => new Set([...postes, ...metiers, ...outils].map((e) => e.toLowerCase()));

// Nom (60 %) et étiquettes communes poste, métier, outil (40 %) ; au plus 5 proches, du plus au moins proche.
export function proches(c: CandidatDoublon, existantes: LigneCatalogue[]): Proche[] {
  const nom = mots(c.nom), tags = etiquettes(c.postes, c.metiers, c.outils);
  return existantes
    .map((l) => ({ id: l.id, code: l.code, nom: l.nom, score: Math.round((0.6 * jaccard(nom, mots(l.nom)) + 0.4 * jaccard(tags, etiquettes(l.postes, l.metiers, l.outils))) * 100) / 100 }))
    .filter((p) => p.score >= SEUIL_DOUBLON)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_PROCHES);
}
