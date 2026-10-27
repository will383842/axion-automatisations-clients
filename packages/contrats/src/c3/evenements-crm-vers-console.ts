import { createHash } from "node:crypto";
import { z } from "zod";
import { EventId } from "../c2/enveloppe.ts";
import { cleDIntention } from "../commun/idempotence.ts";
import { Adresse, Siren, Siret, Texte } from "../commun/identifiants.ts";
// Enveloppe de C3 : celle de C2 (snake_case), producteur et sujet propres au sens.
export const EnveloppeC3 = z.strictObject({
  event_id: EventId,
  schema_version: z.literal(1),
  occurred_at: z.iso.datetime(),
  emitted_at: z.iso.datetime(),
  sequence: z.number().int().nonnegative(),
});
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

// Ce que la console fait de chaque événement reçu : liste fermée, sans aucune action de suppression.
// Règle de Will (C-560, C-623, A-256) : une demande d'effacement coupe les envois, met la personne à l'écart
// et alerte Will ; rien n'est supprimé à réception, l'effacement n'a lieu qu'après une décision tracée de Will.
export const ACTIONS_CONSOLE = [
  "rattacher_ou_proposer",
  "mettre_a_jour_fiche",
  "rattacher_apporteur",
  "suivre_la_fusion",
  "couper_envois_commerciaux",
  "mettre_personne_a_l_ecart",
  "alerter_will",
  "attendre_decision_de_will",
] as const;
export type ActionConsole = (typeof ACTIONS_CONSOLE)[number];
export const REACTIONS_CONSOLE: Record<keyof typeof PAYLOADS, readonly ActionConsole[]> = {
  "entreprise.devenue_cliente": ["rattacher_ou_proposer"],
  "entreprise.mise_a_jour": ["mettre_a_jour_fiche"],
  "apporteur.rattache": ["rattacher_apporteur"],
  "fiche.fusionnee": ["suivre_la_fusion"],
  "consentement.retire": ["couper_envois_commerciaux"],
  "effacement.demande": ["couper_envois_commerciaux", "mettre_personne_a_l_ecart", "alerter_will", "attendre_decision_de_will"],
};

function variante<T extends keyof typeof PAYLOADS>(t: T) {
  return EnveloppeC3.extend({ producer: z.literal("axion-crm"), subject_ref: z.strictObject({ crmCompanyId: Texte }), event_type: z.literal(t), payload: PAYLOADS[t] });
}
const variantes = TYPES_CRM_VERS_CONSOLE.map(variante) as unknown as [ReturnType<typeof variante>, ...ReturnType<typeof variante>[]];
export const EvenementCrm = z.discriminatedUnion("event_type", variantes);
export type EvenementCrm = z.infer<typeof EvenementCrm>;
