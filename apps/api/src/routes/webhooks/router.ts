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
  // Anti-rejeu : l'en-tête x-event-id n'est pas signé, il ne peut donc jamais remplacer l'empreinte du corps (signé).
  // La clé par empreinte (10 min) est toujours posée ; la clé d'événement s'y ajoute quand l'émetteur en donne un.
  const cles = [`webhook:rejeu:${w.id}:h-${empreinte}`, ...(evenement ? [`webhook:rejeu:${w.id}:${evenement}`] : [])];
  const posees: string[] = [];
  const efface = async () => { for (const c of posees) await deps.memoire.del?.(c).catch(() => undefined); };
  let double = false;
  for (const c of cles) {
    if ((await deps.memoire.set(c, "1", "EX", DIX_MINUTES_S, "NX")) === "OK") posees.push(c); else double = true;
  }
  if (double) { await efface(); return "double"; }
  try {
    // Le corps est du contenu métier : scellé par la clé du client, jamais en clair dans la file.
    const scelle = await deps.sceller(w.tenantId, corps);
    const file: FileMinimale = deps.file(`executions-${instance.cellule}`);
    const cle = `${w.id}:${empreinte}:${evenement ?? Math.floor(Date.now() / 1000 / DIX_MINUTES_S)}`;
    await deposer(file, { tenantId: w.tenantId, type: "webhook", cle }, { instanceId: w.instanceId, webhookId: w.id, corps: scelle });
  } catch (e) {
    // Échec passager : la clé ne doit pas faire croire à un doublon quand l'émetteur renvoie.
    await efface();
    throw e;
  }
  return "accepte";
}
