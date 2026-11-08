// Preuve qu'un humain de l'équipe a cliqué (C-557, C-617). Objet opaque : seule une route de l'équipe peut en fabriquer un
// (une garde de source interdit d'importer creerClicEquipe hors de apps/api/src/routes/**). Il ne sert qu'une fois, pour sa seule clé.

export type RoleClic = "will" | "second_administrateur";
export interface ClicEquipe { readonly _opaque: unique symbol }

interface Etat { cle: string; role: RoleClic; acteur: string; utilise: boolean }
const CLICS = new WeakMap<object, Etat>();

export function creerClicEquipe(o: { role: RoleClic; acteur: string }, cle: string): ClicEquipe {
  if (typeof o.acteur !== "string" || o.acteur.trim() === "") throw new Error("acteur du clic absent");
  if (o.role !== "will" && !(o.role === "second_administrateur" && cle === "notificationViolation")) throw new Error("rôle refusé pour ce clic");
  const clic = Object.freeze({}) as ClicEquipe;
  CLICS.set(clic, { cle, role: o.role, acteur: o.acteur, utilise: false });
  return clic;
}

export function consommerClic(clic: ClicEquipe | undefined, cle: string): boolean {
  const etat = typeof clic === "object" && clic !== null ? CLICS.get(clic) : undefined;
  if (!etat || etat.utilise || etat.cle !== cle) return false;
  etat.utilise = true;
  return true;
}
