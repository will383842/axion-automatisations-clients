import { createHash } from "node:crypto";

// Idempotency-Key dérivée de l'intention métier : forme UUID v4 déterministe,
// comme identifiantEvenement d'axion-ia (SHA-256, version 4 et variante forcées).
export function cleDIntention(type: string, idIntention: string): string {
  const h = createHash("sha256").update(JSON.stringify([type, idIntention])).digest("hex");
  const variante = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
