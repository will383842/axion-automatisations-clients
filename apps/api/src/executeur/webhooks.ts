import { randomBytes } from "node:crypto";
import type { WebhookConnu } from "../routes/webhooks/entree.js";

// Création d'un webhook (A-292) : identifiant opaque de 128 bits sans lien lisible avec le client, secret propre rangé au coffre.
// La base ne garde que la référence du secret ; le secret n'est rendu qu'une fois, à l'appelant.
export interface DepsCreation {
  depot: { inserer(w: WebhookConnu): Promise<void> };
  ranger(tenantId: string, secret: string): Promise<string>;
}

export async function creerWebhook(o: { tenantId: string; instanceId: string; schema: WebhookConnu["schema"] }, deps: DepsCreation): Promise<{ id: string; secret: string }> {
  const id = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const secretRef = await deps.ranger(o.tenantId, secret);
  await deps.depot.inserer({ id, tenantId: o.tenantId, instanceId: o.instanceId, schema: o.schema, secretRef, revoque: false });
  return { id, secret };
}
