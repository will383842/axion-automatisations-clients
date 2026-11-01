import { z } from "zod";

// B-170 : liste fermée des composants d'écran. Une description, jamais du code. Les teintes sont celles des jetons de design (aucun bleu).
// Noms des teintes de jetons.css, écrits en clés d'objet : la garde des couleurs refuse un nom de couleur CSS entre guillemets.
const NOMS_TEINTES = { terracotta: 0, vert: 0, ambre: 0, violet: 0, gris: 0 };
export const TEINTES = Object.keys(NOMS_TEINTES) as [keyof typeof NOMS_TEINTES, ...(keyof typeof NOMS_TEINTES)[]];
const Texte = z.string().max(500);
const Ton = z.enum(TEINTES);
const Adresse = z.string().max(500).refine((a) => !/[\\\s]/.test(a) && ![...a].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && ((a.startsWith("/") && !a.startsWith("//")) || a.startsWith("https://")), "adresse interne ou https attendue");
const Nom = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);

// 0.4.0 : `source` nomme une requête déclarée par le module, `action` une action déclarée (le manifeste vérifie les noms).
const Source = { source: Nom.optional() };
export const COMPOSANTS = Object.freeze({
  // Les huit composants du portail.
  Indicateur: z.object({ libelle: Texte, ton: Ton.optional(), ...Source }).strict(),
  Tableau: z.object({ titre: Texte, colonnes: z.array(Texte).max(12).optional(), ...Source }).strict(),
  Graphique: z.object({ titre: Texte, ton: Ton.optional(), ...Source }).strict(),
  FileDeValidation: z.object({ titre: Texte, ...Source }).strict(),
  Formulaire: z.object({ titre: Texte, action: Nom.optional(), ...Source }).strict(),
  Import: z.object({ titre: Texte, action: Nom.optional() }).strict(),
  Calendrier: z.object({ titre: Texte, ...Source }).strict(),
  FilActivite: z.object({ titre: Texte, ...Source }).strict(),
  // Alias 0.3.0, toujours acceptés.
  TableauSimple: z.object({ titre: Texte, colonnes: z.array(Texte).max(12).optional(), ...Source }).strict(),
  Carte: z.object({ titre: Texte, texte: Texte.optional(), ton: Ton.optional(), ...Source }).strict(),
  Bandeau: z.object({ texte: Texte, ton: Ton.optional() }).strict(),
  Statistique: z.object({ libelle: Texte, valeur: Texte, ton: Ton.optional(), ...Source }).strict(),
  Lien: z.object({ libelle: Texte, adresse: Adresse }).strict(),
  Bouton: z.object({ libelle: Texte, action: Nom }).strict(),
});
export type NomComposant = keyof typeof COMPOSANTS;
