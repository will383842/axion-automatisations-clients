import { z } from "zod";

// Argent : centimes entiers et points de base entiers, jamais de flottant (T0-30 : jamais négatifs non plus).
// Un avoir porte un montant positif : c'est le type de fait (`avoir.emis`) qui dit qu'il vient en déduction.
// Un montant à 0 est permis : le prix informe, il ne bloque jamais (une valeur provisoire suffit).
export const Centimes = z.number().int().nonnegative();
export const Bps = z.number().int().nonnegative();
// Pourcentage en points de base : de 0 à 10 000 (acompte de 0 à 100 %).
export const BpsPourcentage = Bps.max(10000);
export type Centimes = z.infer<typeof Centimes>;
export type Bps = z.infer<typeof Bps>;

// TVA de l'activité « automatisation » : constante unique (C-546).
export const TVA_AUTOMATISATION_BPS = 2000;
