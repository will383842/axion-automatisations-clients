// Canal parent ↔ enfant : des messages typés en JSON, rien d'autre (ni fonction, ni descripteur).
export type Json = null | boolean | number | string | Json[] | { [cle: string]: Json };

export interface MessageParent {
  type: "lancer";
  executionId: string;
  // Module vérifié par le parent, en base64 : l'enfant ne lit jamais le disque.
  code: string;
  entree: Json;
  // Jeton court du courtier : il passe ici, jamais par l'environnement.
  jeton?: string;
}
export type MessageEnfant = { type: "resultat"; valeur: Json } | { type: "erreur"; message: string };

const PROFONDEUR_MAX = 64;

export function estJson(v: unknown, profondeur = 0): v is Json {
  if (profondeur > PROFONDEUR_MAX) return false;
  if (v === null || typeof v === "boolean" || typeof v === "string") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => estJson(x, profondeur + 1));
  if (typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v).every((x) => estJson(x, profondeur + 1));
}

export function estMessageParent(m: unknown): m is MessageParent {
  if (typeof m !== "object" || m === null) return false;
  const { type, executionId, code, entree, jeton } = m as Record<string, unknown>;
  return type === "lancer" && typeof executionId === "string" && typeof code === "string" && estJson(entree) && (jeton === undefined || typeof jeton === "string");
}

export function estMessageEnfant(m: unknown): m is MessageEnfant {
  if (typeof m !== "object" || m === null) return false;
  const { type, valeur, message } = m as Record<string, unknown>;
  if (type === "resultat") return estJson(valeur);
  return type === "erreur" && typeof message === "string";
}
