import { ErreurConnecteur } from "./erreurs.ts";

// Jeton opaque fourni par le courtier (T4-39) : la valeur vit hors de l'objet, rien ne l'affiche.
const valeurs = new WeakMap<JetonCourt, { valeur: string; expireA: number }>();

export class JetonCourt {
  toString = () => "[JetonCourt]";
  toJSON = () => "[JetonCourt]";
}

export function creerJeton(valeur: string, expireA: number): JetonCourt {
  if (!valeur || !Number.isFinite(expireA)) throw new Error("jeton invalide");
  const j = new JetonCourt();
  Object.defineProperties(j, { toString: { enumerable: false }, toJSON: { enumerable: false } });
  valeurs.set(j, { valeur, expireA });
  return j;
}

export function avecJeton<T>(jeton: JetonCourt, maintenant: number, f: (valeur: string) => T): T {
  const v = valeurs.get(jeton);
  if (!v || maintenant >= v.expireA) throw new ErreurConnecteur("identification", "jeton_expire");
  return f(v.valeur);
}
