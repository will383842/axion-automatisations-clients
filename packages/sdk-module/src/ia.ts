import { z } from "zod";

export const Ia = z
  .object({
    modelesAdmis: z.array(z.string().min(1)),
    unitesParElement: z.number().int().nonnegative(),
    risqueAiAct: z.enum(["minimal", "limite", "eleve"]),
  })
  .strict();
export type Ia = z.infer<typeof Ia>;
