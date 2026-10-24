import { z } from "zod";
import { Identifiant } from "./configuration.ts";

// Aucun contenu métier : des identifiants, des entiers, des codes fermés. Pas de texte libre.
export const CLASSES_ERREUR = ["passagere", "quota", "identification", "definitive"] as const;

const Entier = z.number().int().nonnegative();
const Execution = { instanceId: Identifiant, executionId: Identifiant };

export const Evenement = z.discriminatedUnion("type", [
  z.object({ type: z.literal("debut"), ...Execution, a: z.iso.datetime() }).strict(),
  z
    .object({
      type: z.literal("fin"),
      ...Execution,
      dureeMs: Entier,
      elements: Entier,
      minutesGagnees: Entier,
      jetons: Entier,
      coutIaMicroCentimes: Entier,
    })
    .strict(),
  z
    .object({ type: z.literal("erreur"), ...Execution, classe: z.enum(CLASSES_ERREUR), code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/) })
    .strict(),
  z.object({ type: z.literal("signal_de_vie"), instanceId: Identifiant, a: z.iso.datetime() }).strict(),
]);
export type Evenement = z.infer<typeof Evenement>;

// POST /api/executeur/v1/evenements : un paquet, signé par la clé de la cellule (commun/signature.ts).
export const Paquet = z.object({ evenements: z.array(Evenement).min(1).max(500) }).strict();
export type Paquet = z.infer<typeof Paquet>;
