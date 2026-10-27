import { z } from "zod";
import { Bps, Centimes } from "../commun/argent.ts";
import { CodeAutomatisation, Date_, PeriodeMois, Siren, Siret, Terme, Texte } from "../commun/identifiants.ts";
import { avecRegles } from "../commun/regles-fond.ts";
import { Enveloppe } from "./enveloppe.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const Devis = z.strictObject({ numeroDevis: Texte, date: Date_ });

// Une ligne par abonnement (une automatisation), avec sa propre période : facture groupée ou seule.
// Contrôle de la somme des lignes : fait par la console à la réception (alerte, rien de corrigé seul), pas par le schéma.
export const LigneFacture = avecRegles(
  z.strictObject({
    referenceAbonnementConsole: Texte,
    codeAutomatisation: CodeAutomatisation,
    idPlan: Texte.optional(),
    libelle: Texte,
    debutPeriode: Date_,
    finPeriode: Date_,
    periodeMois: PeriodeMois,
    terme: Terme,
    montantHtCentimes: Centimes,
    tauxTvaBps: Bps,
  }),
  "periode_ordonnee",
);

// Liens vers ce qui a demandé la facture : brouillon et bon de commande (facture de départ, C-608, C-621),
// abonnement (facture seule). Une facture groupée porte ses abonnements dans ses lignes.
const champsFacture = {
  numeroFacture: Texte,
  idPlan: Texte.optional(),
  idBrouillon: Texte.optional(),
  referenceBonDeCommande: Texte.optional(),
  referenceAbonnementConsole: Texte.optional(),
  montantHtCentimes: Centimes,
  montantTvaCentimes: Centimes,
  montantTtcCentimes: Centimes,
  dateEmission: Date_,
  dateEcheance: Date_,
  pdf: z.strictObject({ url: z.url(), expireAt: z.iso.datetime(), sha256: Sha256 }),
  lignes: z.array(LigneFacture).min(1).optional(),
};

// C-589 : une facture d'abonnement porte toujours sa période (union par nature : la règle passe dans le JSON Schema).
// Facture groupée : sa période va du premier début au dernier fin de ses lignes.
const Facture = z.discriminatedUnion("nature", [
  avecRegles(z.strictObject({ ...champsFacture, nature: z.literal("abonnement"), debutPeriode: Date_, finPeriode: Date_ }), "periode_ordonnee", "ht_tva_ttc"),
  avecRegles(
    z.strictObject({
      ...champsFacture,
      nature: z.enum(["mise_en_place", "complement_prorata", "stockage", "solde_engagement"]),
      debutPeriode: Date_.optional(),
      finPeriode: Date_.optional(),
    }),
    "periode_ordonnee",
    "ht_tva_ttc",
  ),
]);

const Besoin = z.strictObject({
  description: Texte,
  priorite: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  minutesPerduesParSemaineEstimees: z.number().int().nonnegative(),
});

const Fusion = z.strictObject({ axiCliAbsorbe: Texte, axiCliGarde: Texte, annulableJusquau: z.iso.datetime() });

const PAYLOADS = {
  "devis.signe": Devis,
  "devis.refuse": Devis,
  "devis.expire": Devis,
  "facture.emise": Facture,
  "paiement.recu": z.strictObject({ numeroFacture: Texte, montantCentimes: Centimes, dateReception: Date_, moyen: z.literal("virement") }),
  // Montant de l'avoir, positif : il vient en déduction de la facture d'origine.
  "avoir.emis": z.strictObject({ numeroAvoir: Texte, numeroFactureOrigine: Texte, montantHtCentimes: Centimes }),
  "relance.proposee": z.strictObject({ numeroFacture: Texte, niveau: z.number().int().positive(), joursRetard: z.number().int().nonnegative() }),
  "fiche.fusionnee": Fusion,
  "fiche.fusion_annulee": Fusion,
  "audit.cloture": z.strictObject({
    siren: Siren,
    siret: Siret.optional(),
    contact: z.strictObject({ nom: Texte, email: z.email() }),
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
