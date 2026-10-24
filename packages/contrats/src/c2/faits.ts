import { z } from "zod";
import { Centimes } from "../commun/argent.ts";
import { Enveloppe } from "./enveloppe.ts";

const Texte = z.string().min(1);
const Date_ = z.iso.date();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const Devis = z.object({ numeroDevis: Texte, date: Date_ });

const Facture = z
  .object({
    numeroFacture: Texte,
    idPlan: Texte.optional(),
    nature: z.enum(["abonnement", "mise_en_place", "complement_prorata"]),
    debutPeriode: Date_.optional(),
    finPeriode: Date_.optional(),
    montantHtCentimes: Centimes,
    montantTvaCentimes: Centimes,
    montantTtcCentimes: Centimes,
    dateEmission: Date_,
    dateEcheance: Date_,
    pdf: z.object({ url: z.url(), expireAt: z.iso.datetime(), sha256: Sha256 }),
  })
  // C-589 : une facture d'abonnement porte toujours sa période.
  .refine((f) => f.nature !== "abonnement" || (f.debutPeriode !== undefined && f.finPeriode !== undefined), { path: ["debutPeriode"] });

const Besoin = z.object({
  description: Texte,
  priorite: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  minutesPerduesParSemaineEstimees: z.number().int().nonnegative(),
});

const Fusion = z.object({ axiCliAbsorbe: Texte, axiCliGarde: Texte, annulableJusquau: z.iso.datetime() });

const PAYLOADS = {
  "devis.signe": Devis,
  "devis.refuse": Devis,
  "devis.expire": Devis,
  "facture.emise": Facture,
  "paiement.recu": z.object({ numeroFacture: Texte, montantCentimes: Centimes, dateReception: Date_, moyen: z.literal("virement") }),
  "avoir.emis": z.object({ numeroAvoir: Texte, numeroFactureOrigine: Texte, montantHtCentimes: Centimes }),
  "relance.proposee": z.object({ numeroFacture: Texte, niveau: z.number().int().positive(), joursRetard: z.number().int().nonnegative() }),
  "fiche.fusionnee": Fusion,
  "fiche.fusion_annulee": Fusion,
  "audit.cloture": z.object({
    siren: z.string().regex(/^[0-9]{9}$/),
    siret: z.string().regex(/^[0-9]{14}$/).optional(),
    contact: z.object({ nom: Texte, email: z.email() }),
    typeAudit: z.enum(["diagnostic_distance", "audit_sur_place"]),
    dateAudit: Date_,
    outils: z.array(Texte),
    besoins: z.array(Besoin),
    lienCompteRendu: z.url(),
  }),
} as const;

export const TYPES_DE_FAITS = Object.keys(PAYLOADS) as (keyof typeof PAYLOADS)[];

type Variante<T extends keyof typeof PAYLOADS> = z.ZodObject<
  typeof Enveloppe.shape & { event_type: z.ZodLiteral<T>; payload: (typeof PAYLOADS)[T] }
>;

const variantes = TYPES_DE_FAITS.map((t) => Enveloppe.extend({ event_type: z.literal(t), payload: PAYLOADS[t] })) as unknown as [
  Variante<"devis.signe">,
  ...Variante<keyof typeof PAYLOADS>[],
];

export const Fait = z.discriminatedUnion("event_type", variantes);
export type Fait = z.infer<typeof Fait>;
