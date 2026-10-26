import { z } from "zod";
import { Identifiant } from "./configuration.ts";

// État voulu léger : un état, l'arrêt des envois (C-534) et une version, jamais les réglages.
export const EtatVoulu = z
  .object({ instanceId: Identifiant, etat: z.enum(["actif", "pause", "arrete"]), arretEnvois: z.boolean(), version: z.number().int().nonnegative() })
  .strict();
export type EtatVoulu = z.infer<typeof EtatVoulu>;
