import { z } from "zod";

// B-170 : liste fermée des composants d'écran. Une description, jamais du code. Les teintes sont celles des jetons de design (aucun bleu).
// Noms des teintes de jetons.css, écrits en clés d'objet : la garde des couleurs refuse un nom de couleur CSS entre guillemets.
const NOMS_TEINTES = { terracotta: 0, vert: 0, ambre: 0, violet: 0, gris: 0 };
export const TEINTES = Object.keys(NOMS_TEINTES) as [keyof typeof NOMS_TEINTES, ...(keyof typeof NOMS_TEINTES)[]];
const Texte = z.string().max(500);
const Ton = z.enum(TEINTES);
const Adresse = z.string().max(500).refine((a) => !/[\\\s]/.test(a) && ![...a].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && ((a.startsWith("/") && !a.startsWith("//")) || a.startsWith("https://")), "adresse interne ou https attendue");
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
