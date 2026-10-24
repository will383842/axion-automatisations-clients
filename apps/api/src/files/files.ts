import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

// Files de tâches BullMQ (A-051, A-191). Le cloisonnement par client vient au lot 2b : ici, seulement le tenantId obligatoire.

export const PREFIXE = "axion";

const Intention = z.object({
  tenantId: z.uuid({ error: "tenantId doit être un UUID" }),
  type: z.string().min(1),
  cle: z.string().min(1),
});
export type Intention = z.infer<typeof Intention>;

// Les données d'une tâche : l'objet libre de l'appelant, plus le tenantId de l'intention (qui prime).
const Donnees = z.looseObject({ tenantId: z.uuid({ error: "tenantId doit être un UUID" }) });

export interface FileMinimale {
  name: string;
  add: (nom: string, donnees: unknown, opts?: { jobId?: string }) => Promise<unknown>;
}

export function creerFile(nom: string, connexion: Redis): Queue {
  return new Queue(nom, { connection: connexion, prefix: PREFIXE });
}

// Même intention métier → même jobId → BullMQ garde une seule tâche. Longueur préfixée : aucune confusion entre champs.
export function idTache(intention: Intention): string {
  const { tenantId, type, cle } = Intention.parse(intention);
  const h = createHash("sha256");
  for (const champ of [tenantId, type, cle]) h.update(`${champ.length}:${champ}`);
  return h.digest("hex");
}

export async function deposer(file: FileMinimale, intention: Intention, donnees: Record<string, unknown>): Promise<void> {
  const jobId = idTache(intention);
  const valides = Donnees.parse({ ...donnees, tenantId: intention.tenantId });
  await file.add(intention.type, valides, { jobId });
}
