import { z } from "zod";
import { avecRegles } from "./regles-fond.ts";

// Formes partagées par C1, C2 et C3 : un seul SIREN, un seul SIRET, une seule adresse (T0-30).
export const Texte = z.string().min(1);
export const Date_ = z.iso.date();
// Code d'une automatisation : même motif que le code de module de C4.
export const CodeAutomatisation = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
// Curseur opaque (statuts, rattrapage des faits) : jamais vide ; le premier appel envoie CURSEUR_INITIAL.
export const CURSEUR_INITIAL = "0";
export const Curseur = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

// Abonnements indépendants (une automatisation = un abonnement) : période en mois entiers et terme.
export const PERIODE_MAX_MOIS = 12;
export const PeriodeMois = z.number().int().min(1).max(PERIODE_MAX_MOIS);
export const TERMES = ["a_echoir", "echu"] as const;
export const Terme = z.enum(TERMES);

// SIREN : 9 chiffres et contrôle de Luhn (règle de fond `siren_luhn`, nommée dans le JSON Schema). SIRET : 14 chiffres.
export const Siren = avecRegles(z.string().regex(/^[0-9]{9}$/), "siren_luhn");
export const Siret = z.string().regex(/^[0-9]{14}$/);
export const Adresse = z.strictObject({ ligne1: Texte, ligne2: Texte.optional(), codePostal: Texte, ville: Texte, pays: z.literal("FR") });
