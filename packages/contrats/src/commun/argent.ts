import { z } from "zod";

// Argent : centimes entiers et points de base entiers, jamais de flottant.
export const Centimes = z.number().int();
export const Bps = z.number().int();
export type Centimes = z.infer<typeof Centimes>;
export type Bps = z.infer<typeof Bps>;

// TVA de l'activité « automatisation » : constante unique (C-546).
export const TVA_AUTOMATISATION_BPS = 2000;
