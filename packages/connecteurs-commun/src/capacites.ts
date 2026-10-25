import { z } from "zod";
import { Garantie } from "@axion-auto/sdk-module";

// Actions génériques par famille : l'automatisation ne connaît jamais l'outil (A-394).
export const ACTIONS_MESSAGERIE = ["lister_nouveaux", "lire", "etiqueter", "creer_brouillon", "envoyer"] as const;
export const ACTIONS: Record<string, readonly string[]> = { messagerie: ACTIONS_MESSAGERIE };

export const Capacite = z.object({ action: z.string().min(1), garantie: Garantie }).strict();
export type Capacite = z.infer<typeof Capacite>;
