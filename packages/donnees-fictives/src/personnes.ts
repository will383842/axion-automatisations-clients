import type { Generateur } from "./graine.js";
import { genererTelephone, slug } from "./entreprises.js";

const PRENOMS = ["Aliénor", "Basile", "Capucine", "Dorian", "Éloïse", "Fabrice", "Gaëlle", "Hugo", "Inès", "Jules", "Karine", "Lucien"];
const NOMS = ["Vaudrelin", "Montaigret", "Sablonnier", "Escorbiac", "Thibarel", "Roncevaux-Lamy", "Pellegrand", "Dufresnoy", "Chaumeil", "Lavernette"];

export type Personne = { prenom: string; nom: string; email: string; telephone: string };

export function genererPersonne(g: Generateur): Personne {
  const prenom = g.choisir(PRENOMS);
  const nom = g.choisir(NOMS);
  return { prenom, nom, email: `${slug(prenom)}.${slug(nom)}@${g.choisir(["exemple.fr", "personnes.test"] as const)}`, telephone: genererTelephone(g) };
}
