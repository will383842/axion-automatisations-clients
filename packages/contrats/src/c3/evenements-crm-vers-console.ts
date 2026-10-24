import { createHash } from "node:crypto";
import { z } from "zod";
import { EventId } from "../c2/enveloppe.ts";
import { cleDIntention } from "../commun/idempotence.ts";
import { Adresse, Siren, Siret } from "./lecture-entreprise.ts";
// Enveloppe de C3 : celle de C2 (snake_case), producteur et sujet propres au sens.
export const EnveloppeC3 = z.object({
  event_id: EventId,
  schema_version: z.literal(1),
  occurred_at: z.iso.datetime(),
  emitted_at: z.iso.datetime(),
  sequence: z.number().int().nonnegative(),
});
const Texte = z.string().min(1);
// SHA-256 hexadécimal de l'e-mail en minuscules, sans espaces : jamais l'e-mail en clair.
export const empreinteEmail = (email: string): string => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
// event_id déterministe : la même intention métier donne toujours le même identifiant.
export const identifiantEvenementC3 = (type: string, cle: string): string => cleDIntention(`c3:${type}`, cle);
const Personne = z.strictObject({ personKey: Texte, emailEmpreinte: z.string().regex(/^[0-9a-f]{64}$/) });
const PAYLOADS = {
  "entreprise.devenue_cliente": z.strictObject({
    crmCompanyId: Texte,
    siren: Siren,
    siret: Siret.optional(),
    raisonSociale: Texte,
    adresse: Adresse,
    contacts: z.array(z.strictObject({ nom: Texte, email: z.email() })),
  }),
  "entreprise.mise_a_jour": z.strictObject({ crmCompanyId: Texte, raisonSociale: Texte.optional(), adresse: Adresse.optional(), siret: Siret.optional() }),
  "apporteur.rattache": z.strictObject({ crmCompanyId: Texte, apporteurId: Texte }),
  "fiche.fusionnee": z.strictObject({ crmCompanyIdAbsorbee: Texte, crmCompanyIdGardee: Texte }),
  "consentement.retire": Personne,
  "effacement.demande": Personne,
} as const;
export const TYPES_CRM_VERS_CONSOLE = Object.keys(PAYLOADS) as (keyof typeof PAYLOADS)[];
function variante<T extends keyof typeof PAYLOADS>(t: T) {
  return EnveloppeC3.extend({ producer: z.literal("axion-crm"), subject_ref: z.object({ crmCompanyId: Texte }), event_type: z.literal(t), payload: PAYLOADS[t] });
}
const variantes = TYPES_CRM_VERS_CONSOLE.map(variante) as unknown as [ReturnType<typeof variante>, ...ReturnType<typeof variante>[]];
export const EvenementCrm = z.discriminatedUnion("event_type", variantes);
export type EvenementCrm = z.infer<typeof EvenementCrm>;
