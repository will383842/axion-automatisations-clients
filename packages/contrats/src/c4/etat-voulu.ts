import { z } from "zod";
import { Identifiant } from "./configuration.ts";

// État voulu léger : un état et une version, jamais les réglages.
export const EtatVoulu = z
  .object({ instanceId: Identifiant, etat: z.enum(["actif", "pause", "arrete"]), version: z.number().int().nonnegative() })
  .strict();
export type EtatVoulu = z.infer<typeof EtatVoulu>;
