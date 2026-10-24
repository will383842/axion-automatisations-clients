import { z } from "zod";

// C4 : l'exécuteur lit la configuration d'une instance, puis la garde en cache 24 h au plus.
export const PREFIXE_C4 = "/api/executeur/v1";
export const DUREE_CACHE_MAX_SECONDES = 86400;

export const Identifiant = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const Configuration = z
  .object({
    instanceId: Identifiant,
    moduleCode: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    moduleVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    reglages: z.record(z.string(), z.json()),
    dureeCacheSecondes: z.number().int().min(1).max(DUREE_CACHE_MAX_SECONDES),
  })
  .strict();
export type Configuration = z.infer<typeof Configuration>;
