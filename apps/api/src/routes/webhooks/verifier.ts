import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookConnu } from "./entree.js";

// Vérification d'un appel entrant (A-292) : signature HMAC-SHA256 du corps brut, ou secret dans un en-tête. Comparaison en temps constant.
const egal = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

export function verifierAppel(schema: WebhookConnu["schema"], secret: string, entetes: Record<string, unknown>, corps: Buffer): boolean {
  const recu = entetes[schema.entete.toLowerCase()];
  if (typeof recu !== "string" || recu.length > 512) return false;
  if (schema.type === "secret") return egal(Buffer.from(recu), Buffer.from(secret));
  const attendu = createHmac("sha256", secret).update(corps).digest("hex");
  return egal(Buffer.from(recu.replace(/^sha256=/, "")), Buffer.from(attendu));
}

// Appel sur un webhook inconnu ou révoqué : même travail qu'une vraie vérification, pour que le temps de réponse ne les distingue pas.
export function verifierFactice(corps: Buffer): void {
  createHmac("sha256", "inconnu").update(corps).digest("hex");
}
