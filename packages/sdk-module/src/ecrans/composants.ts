import { z } from "zod";

// B-170 : liste fermée des composants d'écran. Une description, jamais du code. Les teintes sont celles des jetons de design (aucun bleu).
// « prune » correspond à la teinte violette des jetons : le nom CSS « violet » est refusé par la garde des couleurs.
export const TEINTES = ["terracotta", "vert", "ambre", "prune", "gris"] as const;
const Texte = z.string().max(500);
const Ton = z.enum(TEINTES);
const Adresse = z.string().max(500).refine((a) => (a.startsWith("/") && !a.startsWith("//")) || a.startsWith("https://"), "adresse interne ou https attendue");
const Nom = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);

export const COMPOSANTS = Object.freeze({
  TableauSimple: z.object({ titre: Texte, colonnes: z.array(Texte).max(12).optional() }).strict(),
  Carte: z.object({ titre: Texte, texte: Texte.optional(), ton: Ton.optional() }).strict(),
  Bandeau: z.object({ texte: Texte, ton: Ton.optional() }).strict(),
  Statistique: z.object({ libelle: Texte, valeur: Texte, ton: Ton.optional() }).strict(),
  Lien: z.object({ libelle: Texte, adresse: Adresse }).strict(),
  Bouton: z.object({ libelle: Texte, action: Nom }).strict(),
});
export type NomComposant = keyof typeof COMPOSANTS;
