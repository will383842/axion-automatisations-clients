import { createHash } from "node:crypto";
import { deposer, type FileMinimale } from "../../files/files.js";
import type { DepsWebhooks, WebhookConnu } from "./entree.js";

// Routage (A-083) : l'instance donne sa cellule, le travail part dans « executions-<cellule> » (nom de file BullMQ de la cellule).
// Instance en pause : le travail est quand même déposé, l'exécuteur le garde dans l'ordre (B-437).
const CELLULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENEMENT = /^[A-Za-z0-9._-]{1,128}$/;
const DIX_MINUTES_S = 600;

export const idEvenement = (entetes: Record<string, unknown>): string | undefined => {
  const v = entetes["x-event-id"];
  return typeof v === "string" && EVENEMENT.test(v) ? v : undefined;
};

export type Issue = "accepte" | "double" | "sans_cellule";

export async function router(deps: DepsWebhooks, w: WebhookConnu, entetes: Record<string, unknown>, corps: Buffer): Promise<Issue> {
  const instance = await deps.instance(w.instanceId, w.tenantId);
  if (!instance || !instance.cellule || instance.cellule.length > 64 || !CELLULE.test(instance.cellule)) return "sans_cellule";
  const evenement = idEvenement(entetes);
  const empreinte = createHash("sha256").update(corps).digest("hex");
  // Anti-rejeu : par identifiant d'événement de l'émetteur, sinon 10 min par empreinte du corps ; toujours borné à CE webhook.
  const cle = evenement ?? `h-${empreinte}`;
  const premiere = await deps.memoire.set(`webhook:rejeu:${w.id}:${cle}`, "1", "EX", DIX_MINUTES_S, "NX");
  if (premiere !== "OK") return "double";
  // Le corps est du contenu métier : scellé par la clé du client, jamais en clair dans la file.
  const scelle = await deps.sceller(w.tenantId, corps);
  const file: FileMinimale = deps.file(`executions-${instance.cellule}`);
  await deposer(file, { tenantId: w.tenantId, type: "webhook", cle: `${w.id}:${evenement ?? `${empreinte}:${Math.floor(Date.now() / 1000 / DIX_MINUTES_S)}`}` }, { instanceId: w.instanceId, webhookId: w.id, corps: scelle });
  return "accepte";
}
