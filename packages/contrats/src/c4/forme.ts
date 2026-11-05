import { z } from "zod";

// C4 0.5.0 (ADR 0109, ADR 0112) : forme d'une requête déclarée, sans texte SQL. Schémas indépendants du modèle des bases clients :
// la vérification contre ce modèle (colonnes, types, colonnes chiffrées) est faite à l'import (T4-50c). Même forme que
// apps/api/src/donnees/requetes/structure.ts, qui la reprendra (T4-50b).
export const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
// Lecture seule du schéma commun : aucun autre schéma n'est nommable.
export const TABLE_COMMUN = /^commun\.[a-z][a-z0-9_]{0,62}$/;
export const OPERATEURS = ["egal", "different", "inferieur", "inferieur_ou_egal", "superieur", "superieur_ou_egal", "dans", "est_nul", "n_est_pas_nul"] as const;

const Colonne = z.string().regex(IDENT);
const Alias = z.string().regex(IDENT);
export const Agregat = z.discriminatedUnion("fonction", [
  z.strictObject({ fonction: z.literal("compter"), alias: Alias }),
  z.strictObject({ fonction: z.literal("somme"), colonne: Colonne, alias: Alias }),
]);
export const Filtre = z.strictObject({ colonne: Colonne, operateur: z.enum(OPERATEURS), parametre: z.string().regex(IDENT).optional() });
export const Parametre = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("uuid"), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("texte"), max: z.number().int().min(1).max(200), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("entier"), min: z.number().int(), max: z.number().int(), defaut: z.number().optional() }),
  z.strictObject({ type: z.literal("horodatage"), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("liste_uuid"), max: z.number().int().min(1).max(100), defaut: z.array(z.string()).optional() }),
]);
export type Parametre = z.infer<typeof Parametre>;
export const MAX_PARAMETRES = 30;
export const Parametres = z.record(z.string().regex(IDENT), Parametre).refine((p) => Object.keys(p).length <= MAX_PARAMETRES, `${MAX_PARAMETRES} paramètres au plus`);

const Table = z.string().regex(TABLE_COMMUN);
const Simple = z.strictObject({
  type: z.literal("simple"),
  table: Table,
  sortie: z.union([
    z.strictObject({ lignes: z.array(z.strictObject({ colonne: Colonne, alias: Alias.optional() })).min(1).max(30) }),
    z.strictObject({ agregats: z.array(Agregat).min(1).max(10) }),
  ]),
  filtres: z.array(Filtre).max(10).optional(),
  tri: z.array(z.strictObject({ colonne: Colonne, sens: z.enum(["asc", "desc"]) })).max(3).optional(),
  limite: z.union([z.strictObject({ parametre: z.string().regex(IDENT) }), z.strictObject({ fixe: z.number().int().min(1).max(200) })]).optional(),
});
const Composee = z.strictObject({
  type: z.literal("composee"),
  parties: z.array(z.strictObject({ alias: Alias, table: Table, agregat: Agregat, filtres: z.array(Filtre).max(10).optional() })).min(2).max(5),
});
export const Forme = z.discriminatedUnion("type", [Simple, Composee]);
export type Forme = z.infer<typeof Forme>;
