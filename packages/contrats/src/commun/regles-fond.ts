import type { z } from "zod";

// Règles de fond qu'un JSON Schema ne sait pas dire. Le schéma Zod les applique (refine) et le JSON Schema
// exporté les NOMME par le mot-clé `x-axion-regles` : tout récepteur qui valide par le JSON Schema les applique aussi.
// Le test json-schema.test.ts les branche dans ajv : Zod et JSON Schema donnent le même verdict sur chaque fixture.
export const luhn = (s: string): boolean => {
  let somme = 0;
  [...s].reverse().forEach((c, i) => {
    let d = Number(c);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    somme += d;
  });
  return somme % 10 === 0;
};

const objet = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

export const REGLES_FOND = {
  // SIREN : clé de Luhn.
  siren_luhn: (v: unknown) => typeof v === "string" && luhn(v),
  // Une période ne finit jamais avant de commencer (dates ISO : l'ordre des chaînes est celui des dates).
  periode_ordonnee: (v: unknown) => {
    const { debutPeriode: d, finPeriode: f } = objet(v);
    return typeof d !== "string" || typeof f !== "string" || d <= f;
  },
  // HT + TVA = TTC, au centime.
  ht_tva_ttc: (v: unknown) => {
    const o = objet(v);
    return o.montantHtCentimes as number + (o.montantTvaCentimes as number) === o.montantTtcCentimes;
  },
} as const;
export type RegleFond = keyof typeof REGLES_FOND;

export function avecRegles<T extends z.ZodType>(schema: T, ...noms: RegleFond[]): T {
  let s = schema;
  for (const nom of noms) s = s.refine(REGLES_FOND[nom], { message: nom });
  return s.meta({ "x-axion-regles": noms });
}
