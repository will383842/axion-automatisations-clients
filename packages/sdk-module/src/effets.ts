import { z } from "zod";

// Garantie d'effet externe, déclarée par chaque connecteur.
// Microsoft Graph = verifiable_apres_coup : sans conclusion, « à trancher », jamais de renvoi (C-534).
export const GARANTIES = ["idempotent_par_cle", "verifiable_apres_coup", "au_plus_une_fois"] as const;
export const Garantie = z.enum(GARANTIES);
export type Garantie = z.infer<typeof Garantie>;
