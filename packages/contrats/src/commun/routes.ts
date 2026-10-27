import type { CleLimite } from "./debit.ts";

// Description commune d'une route de C1 à C6 : sa limite de débit et sa règle anti-doublon.
// - `idempotency_key` : écriture commandée (C1) ; Idempotency-Key obligatoire, même clé + même corps = même réponse.
// - `event_id` : fait ou événement poussé (C2, C3) ; le récepteur dédoublonne par event_id, sans Idempotency-Key.
// - `execution` : paquets de C4 ; un seul debut et un seul fin par (instanceId, executionId).
// - `jti` : C6, jeton à usage unique.
// - `lecture` : sans effet.
export type AntiDoublon = "idempotency_key" | "event_id" | "execution" | "jti" | "lecture";

export interface RouteContrat {
  methode: "GET" | "POST";
  chemin: string;
  limite: CleLimite;
  antiDoublon: AntiDoublon;
}
