import { createHash } from "node:crypto";

// Clé d'intention (anti-doublon des effets externes) : UUID v5 sur un espace de noms fixe.
// Entrée = instance, exécution, étape, action, élément, codés en tableau JSON : aucun séparateur ambigu.
// L'action en fait partie : deux actions sur le même élément d'une même étape ont deux clés (ADR 0018).
export const ESPACE_INTENTION = "b1c4a2f0-5d3e-4f6a-9c1b-7e2d8a4f6b30";
const ESPACE = Buffer.from(ESPACE_INTENTION.replaceAll("-", ""), "hex");

export interface EntreeIntention {
  instanceId: string;
  executionId: string;
  etape: string;
  action: string;
  element: string;
}

export function deriverCleIntention(e: EntreeIntention): string {
  const h = createHash("sha1").update(ESPACE).update(JSON.stringify([e.instanceId, e.executionId, e.etape, e.action, e.element])).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
