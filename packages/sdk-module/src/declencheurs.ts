import { z } from "zod";

export const Declencheur = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), expression: z.string().min(1) }).strict(),
  z.object({ type: z.literal("sondage"), intervalleSecondes: z.number().int().positive(), curseur: z.string().min(1) }).strict(),
  z.object({ type: z.literal("webhook"), nom: z.string().min(1) }).strict(),
  z.object({ type: z.literal("manuel") }).strict(),
]);
export type Declencheur = z.infer<typeof Declencheur>;
