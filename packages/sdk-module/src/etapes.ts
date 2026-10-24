import { z } from "zod";

export const Etape = z
  .object({
    nom: z.string().min(1),
    delaiMaxSecondes: z.number().int().positive().default(120),
    nouvellesTentatives: z.number().int().min(0).max(5).default(0),
  })
  .strict();
export type Etape = z.infer<typeof Etape>;
