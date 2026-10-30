import { z } from "zod";
import { Identifiant } from "./configuration.ts";
import { ModeIa, NomDeclare } from "./donnees.ts";

// Mode autonome (V2, C-683) : l'exécuteur lit l'enveloppe, la garde telle quelle et l'ignore en V1 ; jamais journalisée ni copiée.
// Signature de longueur fixe : 64 octets en base64url sans bourrage (86 caractères).
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const EnveloppeSignee = z
  .object({ version: z.number().int().positive(), charge: Base64Url.max(8192), signature: Base64Url.length(86) })
  .strict();

// État voulu léger : un état, l'arrêt des envois (C-534) et une version, jamais les réglages.
// 0.4.0 (additif) : absence de modeIa = via_axion ; de droitsUsage = aucun ; de paiementConstate = false ; d'enveloppeSignee = rien.
export const EtatVoulu = z
  .object({
    instanceId: Identifiant,
    etat: z.enum(["actif", "pause", "arrete"]),
    arretEnvois: z.boolean(),
    version: z.number().int().nonnegative(),
    modeIa: ModeIa.optional(),
    // Noms de `fonctions` du manifeste. Paiement constaté par la console (T4-51), jamais calculé par l'exécuteur.
    droitsUsage: z.array(NomDeclare).max(100).optional(),
    paiementConstate: z.boolean().optional(),
    enveloppeSignee: EnveloppeSignee.optional(),
  })
  .strict();
export type EtatVoulu = z.infer<typeof EtatVoulu>;
