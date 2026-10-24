import { z } from "zod";
import { Bps, Centimes } from "../commun/argent.ts";
import { Fait } from "../c2/faits.ts";

// Champs de C1 (annexe A). Le schéma accepte tout entier pour tauxTvaBps : la règle métier est dans regles.ts.
const Siren = z.string().regex(/^[0-9]{9}$/);
const Siret = z.string().regex(/^[0-9]{14}$/);
const Date_ = z.iso.date();
const Texte = z.string().min(1);
const AxiCli = Texte;

export const StatutClient = z.enum(["prospect", "client_actif", "ancien_client"]);

export const RetrouverOuCreerRequete = z.object({
  consoleClientId: Texte,
  siren: Siren.optional(),
  siret: Siret.optional(),
  raisonSociale: Texte,
  adresse: z.object({ ligne1: Texte, codePostal: Texte, ville: Texte, pays: z.literal("FR") }),
  contactFacturation: z.object({ nom: Texte, email: z.email() }),
});
export const RetrouverOuCreerReponse = z.union([
  z.object({ resultat: z.enum(["retrouve", "cree"]), axiCli: AxiCli }),
  z.object({ resultat: z.literal("a_trancher"), idDemande: Texte }),
]);

export const StatutRequete = z.object({ statut: StatutClient, consoleClientId: Texte });
export const StatutReponse = z.object({ axiCli: AxiCli, statut: StatutClient });

export const LigneDevis = z.object({
  libelle: Texte,
  quantite: z.number().int().positive(),
  prixUnitaireHtCentimes: Centimes,
  activite: z.literal("automatisation"),
  tauxTvaBps: Bps,
});
export const DevisRequete = z.object({ referencePropositionConsole: Texte, lignes: z.array(LigneDevis).min(1) });
export const DevisReponse = z.object({ numeroDevis: Texte });

export const PlanRequete = z.object({
  referenceContratConsole: Texte,
  montantHtCentimesParPeriode: Centimes,
  periodeMois: z.union([z.literal(1), z.literal(6), z.literal(12)]),
  premiereEcheance: Date_,
  engagementMois: z.number().int().nonnegative(),
});
export const PlanReponse = z.object({ idPlan: Texte });

export const CloreRequete = z.object({ dateFin: Date_, motif: Texte });
export const CloreReponse = z.object({ idPlan: Texte, brouillonsNonEmis: z.array(Texte) });

export const NatureFacturePonctuelle = z.enum(["mise_en_place", "complement_prorata"]);
export const FacturePonctuelleRequete = z.object({
  nature: NatureFacturePonctuelle,
  debutPeriode: Date_,
  finPeriode: Date_,
  referenceBonDeCommande: Texte,
});
export const FacturePonctuelleReponse = z.object({ idBrouillon: Texte });

export const StatutsRequete = z.object({ depuis: z.string() });
export const StatutsReponse = z.object({
  elements: z.array(z.object({ type: z.enum(["devis", "facture", "paiement"]), reference: Texte, statut: Texte })),
  curseur: z.string(),
});

export const ApporteursReponse = z.object({ apporteurs: z.array(z.object({ idApporteur: Texte, nom: Texte })) });

export const RattrapageRequete = z.object({ apres: z.string().regex(/^[0-9]+$/) });
export const RattrapageReponse = z.object({ faits: z.array(Fait) });
