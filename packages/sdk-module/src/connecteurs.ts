import { z } from "zod";
import { Garantie } from "./effets.ts";

export const Connecteur = z
  .object({ famille: z.string().min(1), actions: z.array(z.string().min(1)).min(1), portees: z.array(z.string().min(1)), garantie: Garantie })
  .strict();
export type Connecteur = z.infer<typeof Connecteur>;
