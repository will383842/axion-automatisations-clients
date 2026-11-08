// Paliers en résultats (C-205, T3-31a2) : règle pure, sans écriture ni route. La révision de la grille (T3-31c) branchera l'écriture.
// Un palier se dit en résultats livrés (« 300 e-mails par mois »), jamais en IA, jetons ou modèles. `quantite` nulle = « usage étendu ».
// Ce fichier n'importe rien de quotas/ : le « palier » des résultats n'est ni un niveau de service ni un palier de quota (C-582).
export interface Palier { quantite: number | null; unite: string; libelle: string }
export type ResultatPalier = { ok: true; palier: Palier } | { ok: false; raison: string };

const QUANTITE_MAX = 1_000_000_000;
const LONGUEUR_MAX = 80;
// Liste NON exhaustive par nature (règle 9.4) : elle attrape les formulations courantes, pas toutes. Mot entier, pluriel simple accepté.
const MOTS_REFUSES = ["ia", "i a", "intelligence artificielle", "ai", "jeton", "token", "modele", "model", "llm", "gpt", "uia", "prompt", "credit"];
const MOTIF_REFUSE = new RegExp(`(?:^| )(?:${MOTS_REFUSES.join("|")})s?(?= |$)`);

// NFKD, accents retirés, minuscules, toute ponctuation ou espace (insécable compris) devient une espace simple.
export function normaliser(texte: string): string {
  return texte.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const refus = (raison: string): ResultatPalier => ({ ok: false, raison });
const texteValide = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= LONGUEUR_MAX;

export function validerPalier(entree: { quantite: unknown; unite: unknown; libelle: unknown }): ResultatPalier {
  const { quantite, unite, libelle } = entree;
  if (quantite !== null && !(typeof quantite === "number" && Number.isSafeInteger(quantite) && quantite >= 1 && quantite <= QUANTITE_MAX)) return refus("Quantité invalide.");
  if (!texteValide(unite) || !texteValide(libelle)) return refus("Unité ou libellé invalide.");
  if (MOTIF_REFUSE.test(normaliser(unite)) || MOTIF_REFUSE.test(normaliser(libelle))) return refus("Un palier se dit en résultats, pas en IA.");
  return { ok: true, palier: { quantite, unite: unite.trim(), libelle: libelle.trim() } };
}
