import { z } from "zod";

// Enveloppe d'axion-ia : les noms du fil gardent le snake_case (event_id, occurred_at) ; le payload est en camelCase.
export const EventId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const Enveloppe = z.object({
  event_id: EventId,
  schema_version: z.literal(1),
  occurred_at: z.iso.datetime(),
  emitted_at: z.iso.datetime(),
  producer: z.literal("axion-ia-hub"),
  subject_ref: z.object({ axiCli: z.string().min(1), consoleClientId: z.string().min(1).optional() }),
  sequence: z.number().int().nonnegative(),
});
