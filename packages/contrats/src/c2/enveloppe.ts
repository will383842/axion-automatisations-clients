import { z } from "zod";
import type { RouteContrat } from "../commun/routes.ts";

// Enveloppe d'axion-ia : les noms du fil gardent le snake_case (event_id, occurred_at) ; le payload est en camelCase.
export const EventId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

// Faits poussés par le Hub vers l'API de la console, signés par la clé du Hub (un secret par sens).
// Pas d'Idempotency-Key : la console dédoublonne par event_id (ADR 0002, ADR 0031).
export const ROUTE_C2 = { methode: "POST", chemin: "/api/hub/v1/faits", limite: "c2", antiDoublon: "event_id" } as const satisfies RouteContrat;

// `sequence` croît par sujet (axiCli) : elle sert à ranger les faits d'un client, pas de curseur de rattrapage.
export const Enveloppe = z.strictObject({
  event_id: EventId,
  schema_version: z.literal(1),
  occurred_at: z.iso.datetime(),
  emitted_at: z.iso.datetime(),
  producer: z.literal("axion-ia-hub"),
  subject_ref: z.strictObject({ axiCli: z.string().min(1), consoleClientId: z.string().min(1).optional() }),
  sequence: z.number().int().nonnegative(),
});
