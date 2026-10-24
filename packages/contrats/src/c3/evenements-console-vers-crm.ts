import { z } from "zod";
import { EnveloppeC3 } from "./evenements-crm-vers-console.ts";
const Texte = z.string().min(1);
const Date_ = z.iso.date();
const Client = { consoleClientId: Texte };
const PAYLOADS = {
  "client.cree": z.strictObject({ ...Client, crmCompanyId: Texte }),
  "client.statut": z.strictObject({ ...Client, statut: z.enum(["client", "dormant", "perdu"]) }),
  // Minimisation : résumé du plan SANS montant (le schéma strict refuse tout champ en plus).
  "plan.resume": z.strictObject({
    ...Client,
    codesAutomatisation: z.array(Texte),
    palier: Texte,
    periodeMois: z.union([z.literal(1), z.literal(6), z.literal(12)]),
    prochaineEcheance: Date_,
  }),
  "renouvellement.proche": z.strictObject({ ...Client, dateRenouvellement: Date_ }),
  "impaye.signale": z.strictObject({ ...Client, joursRetard: z.number().int().nonnegative() }),
  "automatisation.activee": z.strictObject({ ...Client, codeAutomatisation: Texte, dateActivation: Date_ }),
  "contrat.resilie": z.strictObject({ ...Client, dateResiliation: Date_ }),
} as const;
export const TYPES_V1 = Object.keys(PAYLOADS) as (keyof typeof PAYLOADS)[];
// V2 : connus mais refusés en V1 (ils ne figurent pas dans l'union).
export const TYPES_V2 = ["maintenance.fin_incluse", "risque_depart"] as const;
function variante<T extends keyof typeof PAYLOADS>(t: T) {
  return EnveloppeC3.extend({ producer: z.literal("axion-console"), subject_ref: z.object(Client), event_type: z.literal(t), payload: PAYLOADS[t] });
}
const variantes = TYPES_V1.map(variante) as unknown as [ReturnType<typeof variante>, ...ReturnType<typeof variante>[]];
export const EvenementConsole = z.discriminatedUnion("event_type", variantes);
export type EvenementConsole = z.infer<typeof EvenementConsole>;
// Correspondance des statuts C1 (Hub) et C3 (CRM), tenue par la console.
export type StatutHub = "prospect" | "client_actif" | "ancien_client";
export type StatutCrm = "client" | "dormant" | "perdu";
export const statutCrmDepuisHub = (s: StatutHub): StatutCrm | null => ({ prospect: null, client_actif: "client", ancien_client: "perdu" } as const)[s];
// `dormant` n'a pas d'équivalent dans le Hub : il reste client_actif tant qu'un contrat court.
export const statutHubDepuisCrm = (s: StatutCrm): StatutHub => ({ client: "client_actif", dormant: "client_actif", perdu: "ancien_client" } as const)[s];
