import { z } from "zod";
import { Bps, BpsPourcentage, Centimes } from "../commun/argent.ts";
import { Adresse, CodeAutomatisation, Curseur, Date_, Siren, Siret, Texte } from "../commun/identifiants.ts";
import { avecRegles } from "../commun/regles-fond.ts";
import { Fait } from "../c2/faits.ts";

// Champs de C1 (annexe A). Tous les objets sont stricts : un champ inconnu est refusé, comme dans le JSON Schema
// exporté (une seule règle, ADR 0031). Le schéma accepte tout entier positif pour tauxTvaBps : la règle métier est dans regles.ts.
const AxiCli = Texte;

export const StatutClient = z.enum(["prospect", "client_actif", "ancien_client"]);

export const RetrouverOuCreerRequete = z.strictObject({
  consoleClientId: Texte,
  siren: Siren.optional(),
  siret: Siret.optional(),
  raisonSociale: Texte,
  adresse: Adresse,
  contactFacturation: z.strictObject({ nom: Texte, email: z.email() }),
});
// 200 : fiche retrouvée ou créée ; 202 : demande à trancher, rien n'est créé.
export const RetrouverOuCreerReponse200 = z.strictObject({ resultat: z.enum(["retrouve", "cree"]), axiCli: AxiCli });
export const RetrouverOuCreerReponse202 = z.strictObject({ resultat: z.literal("a_trancher"), idDemande: Texte });

export const StatutRequete = z.strictObject({ statut: StatutClient, consoleClientId: Texte });
export const StatutReponse = z.strictObject({ axiCli: AxiCli, statut: StatutClient });

export const LigneDevis = z.strictObject({
  libelle: Texte,
  quantite: z.number().int().positive(),
  prixUnitaireHtCentimes: Centimes,
  activite: z.literal("automatisation"),
  tauxTvaBps: Bps,
});
// Chaque écriture nomme le client (axiCli) : le Hub ne devine jamais la fiche, et l'empreinte du corps
// (Idempotency-Key) couvre le client.
export const DevisRequete = z.strictObject({ axiCli: AxiCli, referencePropositionConsole: Texte, lignes: z.array(LigneDevis).min(1) });
export const DevisReponse = z.strictObject({ numeroDevis: Texte });

// Un plan = un abonnement = une automatisation : le plan porte ce que chaque ligne de facture C2 rend obligatoire
// (`codeAutomatisation`, `referenceAbonnementConsole`), sinon le Hub ne saurait pas la remplir (ADR 0033, avant le gel).
// Période : 1, 6 ou 12 mois en 1.0.0, sous-ensemble de PeriodeMois ; l'élargir viendra avec T7-29, Hub d'abord (additif).
export const PlanRequete = z.strictObject({
  axiCli: AxiCli,
  codeAutomatisation: CodeAutomatisation,
  referenceAbonnementConsole: Texte,
  referenceContratConsole: Texte,
  montantHtCentimesParPeriode: Centimes,
  periodeMois: z.union([z.literal(1), z.literal(6), z.literal(12)]),
  premiereEcheance: Date_,
  engagementMois: z.number().int().nonnegative(),
});
export const PlanReponse = z.strictObject({ idPlan: Texte });

// Motif de clôture : vocabulaire fermé (invariant C5 n° 5), jamais un texte libre envoyé au Hub.
export const MotifCloture = z.enum(["fin_engagement", "resiliation", "fin_de_contrat", "changement_de_palier", "changement_de_regroupement", "autre"]);
export const CloreRequete = z.strictObject({ dateFin: Date_, motif: MotifCloture });
export const CloreReponse = z.strictObject({ idPlan: Texte, brouillonsNonEmis: z.array(Texte) });

// Facture de départ en BROUILLON : client, automatisation (unicité C-608), lignes et acompte (0 à 100 %).
export const NatureFacturePonctuelle = z.enum(["mise_en_place", "complement_prorata"]);
export const FacturePonctuelleRequete = avecRegles(
  z.strictObject({
    axiCli: AxiCli,
    codeAutomatisation: CodeAutomatisation,
    nature: NatureFacturePonctuelle,
    debutPeriode: Date_,
    finPeriode: Date_,
    referenceBonDeCommande: Texte,
    lignes: z.array(LigneDevis).min(1),
    acompteBps: BpsPourcentage,
  }),
  "periode_ordonnee",
);
export const FacturePonctuelleReponse = z.strictObject({ idBrouillon: Texte });

// Les paramètres de requête arrivent en texte. `depuis` : CURSEUR_INITIAL au premier appel, puis le `curseur` rendu.
export const StatutsRequete = z.strictObject({ depuis: Curseur });
const Element = <T extends string, S extends readonly [string, ...string[]]>(type: T, statuts: S) =>
  z.strictObject({ type: z.literal(type), reference: Texte, statut: z.enum(statuts) });
export const StatutsReponse = z.strictObject({
  elements: z.array(
    z.discriminatedUnion("type", [
      Element("devis", ["envoye", "signe", "refuse", "expire"] as const),
      Element("facture", ["brouillon", "emise", "payee_partiellement", "payee"] as const),
      Element("paiement", ["recu", "rejete"] as const),
    ]),
  ),
  curseur: Curseur,
});

export const ApporteursReponse = z.strictObject({ apporteurs: z.array(z.strictObject({ idApporteur: Texte, nom: Texte })) });

// Rattrapage de C2 : curseur GLOBAL opaque (jamais la `sequence`, qui ne croît que par sujet), limite et suite.
export const LIMITE_RATTRAPAGE_MAX = 500;
export const RattrapageRequete = z.strictObject({
  apres: Curseur,
  limite: z.string().regex(/^(500|[1-4][0-9]{2}|[1-9][0-9]?)$/).optional(),
  axiCli: AxiCli.optional(),
});
// `suivant` : curseur à renvoyer au prochain appel ; `complet` : rien de plus à lire pour l'instant.
export const RattrapageReponse = z.strictObject({ faits: z.array(Fait).max(LIMITE_RATTRAPAGE_MAX), suivant: Curseur, complet: z.boolean() });
