import { ErreurApi } from "../plugins/erreurs.js";

// Portée d'un membre : un seul sens, ici. Le dirigeant n'est pas limité ; pour le second administrateur, une liste VIDE ne donne accès à RIEN (échec fermé).
export interface Portee { clients: string[]; automatisations: string[] }
export interface MembrePortee { role: string; portee: Portee }

// Marqueur explicite « tous les clients » : seule une portée qui le porte ouvre une route globale à un second administrateur. Une liste vide ne le porte pas.
export const TOUS_LES_CLIENTS = "*";
export function couvreTousLesClients(m: MembrePortee): boolean {
  return m.role === "dirigeant" || (m.role === "second_administrateur" && m.portee.clients.includes(TOUS_LES_CLIENTS));
}

export function dansPortee(m: MembrePortee, clientId: unknown): boolean {
  if (m.role === "dirigeant") return true;
  return m.role === "second_administrateur" && typeof clientId === "string" && m.portee.clients.includes(clientId);
}

// Recherche, export, action groupée : on ne garde que ce qui est dans la portée.
export function filtrerParPortee(m: MembrePortee, ids: string[]): string[] {
  return ids.filter((id) => dansPortee(m, id));
}

// Une action groupée dont UN SEUL élément est hors portée est refusée en entier : 404, sans dire lequel.
export function exigerToutDansPortee(m: MembrePortee, ids: string[]): void {
  if (ids.some((id) => !dansPortee(m, id))) throw new ErreurApi("introuvable", "Ressource introuvable.");
}
