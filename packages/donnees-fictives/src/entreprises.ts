import type { Generateur } from "./graine.js";
import { PLAGES_TELEPHONE_FICTION } from "../../../scripts/scanner-journaux.js";

// Mots inventés : aucune liste de faux noms externe. Aucun ne désigne une vraie entreprise.
const METIERS = ["Menuiserie", "Maçonnerie", "Électricité", "Plomberie", "Peinture", "Charpente", "Toiture", "Carrelage", "Serrurerie", "Paysage"];
const MOTS = ["Valdrenne", "Corlevat", "Mirandelle", "Tovarel", "Brisquant", "Olmeraie", "Pestavin", "Quillemar", "Sorbanel", "Trevolac", "Ymbrelle", "Dovicourt", "Falmarin", "Genestrel", "Hautevoie"];
export const FORMES_JURIDIQUES = ["SARL", "SAS", "SASU", "EURL", "SA"] as const;
// Hors 86.xx et 87.xx (santé, social) : réservés aux cas d'essai marqués.
const CODES_NAF = ["41.20A", "43.21A", "43.22A", "43.31Z", "43.32A", "43.34Z", "43.91A", "81.30Z", "68.31Z", "47.11B"];
const VOIES = ["rue des Taillefers", "allée du Clos Marivelle", "chemin des Quenotiers", "impasse Ravelonde", "place de l'Orme Tordu", "avenue des Brumaires"];
const VILLES: readonly (readonly [string, string])[] = [["Lyon", "69003"], ["Nantes", "44000"], ["Toulouse", "31000"], ["Lille", "59000"], ["Rennes", "35000"], ["Dijon", "21000"]];

export type Adresse = { ligne1: string; codePostal: string; ville: string; pays: "FR" };

export const slug = (texte: string): string => texte.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function genererRaisonSociale(g: Generateur): { nom: string; forme: string } {
  return { nom: `${g.choisir(METIERS)} ${g.choisir(MOTS)}`, forme: g.choisir(FORMES_JURIDIQUES) };
}
export const genererNaf = (g: Generateur): string => g.choisir(CODES_NAF);

export function genererAdresse(g: Generateur): Adresse {
  const [ville, codePostal] = g.choisir(VILLES);
  return { ligne1: `${g.entier(1, 98)} ${g.choisir(VOIES)}`, codePostal, ville, pays: "FR" };
}

// Plages importées de la constante unique (scanner-journaux), jamais recopiées.
export const genererTelephone = (g: Generateur): string => g.choisir(PLAGES_TELEPHONE_FICTION) + g.chiffres(4);

export function genererCourrielEntreprise(g: Generateur, nom: string): string {
  return g.suivant() < 0.5 ? `contact@${slug(nom)}.test` : `contact-${slug(nom)}@exemple.fr`;
}
