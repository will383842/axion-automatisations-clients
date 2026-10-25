import type { z } from "zod";

// Erreur typée des réglages : le code vient du catalogue (reglage.*), jamais d'un texte libre.
export class ReglageRefuse extends Error {
  constructor(readonly code: string, readonly champ: string) {
    super(`${code} : ${champ}`);
  }
}

type Def = { type: string; innerType?: z.ZodType };
const def = (s: z.ZodType) => (s as unknown as { def: Def }).def;
const ENVELOPPES = new Set(["optional", "default", "nullable", "readonly", "prefault"]);

// Retire les enveloppes optional/default/nullable pour atteindre le type réel du champ.
export function deballer(champ: z.ZodType): z.ZodType {
  let s = champ;
  while (ENVELOPPES.has(def(s).type) && def(s).innerType) s = def(s).innerType as z.ZodType;
  return s;
}

export const type = (champ: z.ZodType): string => def(deballer(champ)).type;
// B-353 : toute option (booléen) est désactivée tant que le client ne l'a pas activée.
export const estOption = (champ: z.ZodType): boolean => type(champ) === "boolean";
