import { z } from "zod";
import type { ContexteEtape } from "./contexte.ts";

// Le nombre d'essais n'est pas réglable par étape : POLITIQUES.passagere.essais le fixe pour tous.
export const Etape = z
  .object({
    nom: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    delaiMaxSecondes: z.number().int().positive().default(120),
    executer: z.custom<(ctx: ContexteEtape) => Promise<void>>((v) => typeof v === "function", "executer : fonction d'exécution obligatoire"),
  })
  .strict();
export type Etape = z.infer<typeof Etape>;
