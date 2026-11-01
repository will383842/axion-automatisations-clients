// Contrat commun d'un module en code et d'un module enveloppe (A-308, A-310) : même entrée, mêmes événements, même fiche.
export type Json = null | boolean | number | string | Json[] | { [cle: string]: Json };

export interface Evenement {
  type: string;
  donnees: Json;
}
export interface Sortie {
  evenements: Evenement[];
}
export interface Fiche {
  nom: string;
  champs: string[];
}
export interface ModuleExecutable {
  fiche: Fiche;
  executer(entree: Json): Promise<Sortie>;
}
// Entrée de ops/briques/<nom>.json (schéma de la garde des briques), sans les champs d'exploitation.
export interface Brique {
  nom: string;
  image: string;
  version: string;
  empreinte: string;
  licence: string;
}

// Forme unique des événements : un type non vide, rien d'autre.
export function versEvenements(s: Sortie): Evenement[] {
  return s.evenements.map((e) => {
    if (typeof e.type !== "string" || e.type === "") throw new Error("événement sans type");
    return { type: e.type, donnees: e.donnees };
  });
}
