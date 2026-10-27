import { describe, expect, it } from "vitest";
import { Centimes } from "../commun/argent.ts";
import { STATUT_PAR_CODE } from "../commun/erreurs.ts";
import { ROUTES_C1 } from "./routes.ts";
import { verifierLigneDevis } from "./regles.ts";
import { CloreRequete, DevisRequete, FacturePonctuelleRequete, PlanRequete, RattrapageRequete, StatutsReponse } from "./schemas.ts";

const ligne = { libelle: "Ligne d'essai", quantite: 1, prixUnitaireHtCentimes: 12345, activite: "automatisation", tauxTvaBps: 2000 } as const;
const AXI = "AXI-CLI-000001";
const ponctuelle = {
  axiCli: AXI, codeAutomatisation: "tri-courriels", nature: "mise_en_place", debutPeriode: "2026-11-01", finPeriode: "2026-11-30",
  referenceBonDeCommande: "bdc-0001", lignes: [ligne], acompteBps: 3000,
} as const;
const sans = (o: object, cle: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== cle));

describe("contrat C1", () => {
  it("[LOT0-c1] C1 compte 9 routes", () => {
    expect(Object.keys(ROUTES_C1)).toHaveLength(9);
  });

  it("[A-092] aucune route de C1 ne contient « pause »", () => {
    for (const [nom, r] of Object.entries(ROUTES_C1)) {
      expect(`${nom} ${r.chemin}`.toLowerCase()).not.toContain("pause");
    }
  });

  it("[C-546] une ligne à tauxTvaBps 0 est refusée en 422 tva_interdite", () => {
    expect(DevisRequete.safeParse({ axiCli: AXI, referencePropositionConsole: "prop-1", lignes: [{ ...ligne, tauxTvaBps: 0 }] }).success).toBe(true);
    expect(verifierLigneDevis({ ...ligne, tauxTvaBps: 0 })).toEqual({ code: "tva_interdite", statut: 422 });
    expect(STATUT_PAR_CODE.tva_interdite).toBe(422);
    expect(verifierLigneDevis(ligne)).toBeNull();
  });

  it("[LOT0-c1] montant flottant refusé", () => {
    expect(Centimes.safeParse(12345).success).toBe(true);
    expect(Centimes.safeParse(123.45).success).toBe(false);
    expect(DevisRequete.safeParse({ axiCli: AXI, referencePropositionConsole: "prop-1", lignes: [{ ...ligne, prixUnitaireHtCentimes: 100.5 }] }).success).toBe(false);
  });

  it("[LOT0-c1] les codes d'erreur sont fermés avec leur statut HTTP", () => {
    expect(STATUT_PAR_CODE).toMatchObject({ identifiant_deja_pris: 409, fiche_absorbee: 422, cle_reutilisee: 409, porte_fermee: 503, debit_depasse: 429 });
    expect(Object.keys(STATUT_PAR_CODE)).toHaveLength(15);
  });

  it("[LOT0-c1] devis, plan et facture ponctuelle nomment le client : sans axiCli, refusés", () => {
    expect(DevisRequete.safeParse({ referencePropositionConsole: "prop-1", lignes: [ligne] }).success).toBe(false);
    const plan = { axiCli: AXI, referenceContratConsole: "contrat-0001", montantHtCentimesParPeriode: 12345, periodeMois: 6, premiereEcheance: "2026-11-01", engagementMois: 12 };
    expect(PlanRequete.safeParse(plan).success).toBe(true);
    expect(PlanRequete.safeParse(sans(plan, "axiCli")).success).toBe(false);
    expect(FacturePonctuelleRequete.safeParse(ponctuelle).success).toBe(true);
    expect(FacturePonctuelleRequete.safeParse(sans(ponctuelle, "axiCli")).success).toBe(false);
  });

  it("[C-608] une facture ponctuelle porte son automatisation, ses lignes et un acompte de 0 à 100 %", () => {
    expect(FacturePonctuelleRequete.safeParse(sans(ponctuelle, "codeAutomatisation")).success).toBe(false);
    expect(FacturePonctuelleRequete.safeParse({ ...ponctuelle, lignes: [] }).success).toBe(false);
    expect(FacturePonctuelleRequete.safeParse({ ...ponctuelle, acompteBps: 0 }).success).toBe(true);
    expect(FacturePonctuelleRequete.safeParse({ ...ponctuelle, acompteBps: 10000 }).success).toBe(true);
    expect(FacturePonctuelleRequete.safeParse({ ...ponctuelle, acompteBps: 10001 }).success).toBe(false);
    expect(FacturePonctuelleRequete.safeParse({ ...ponctuelle, debutPeriode: "2026-12-01" }).success).toBe(false);
  });

  it("[LOT0-c1] un champ inconnu est refusé, comme dans le JSON Schema exporté", () => {
    expect(DevisRequete.safeParse({ axiCli: AXI, referencePropositionConsole: "prop-1", lignes: [ligne], remise: 10 }).success).toBe(false);
  });

  it("[LOT0-c1] la réponse 200 de retrouver-ou-creer n'accepte pas a_trancher, la 202 n'accepte que a_trancher", () => {
    const { 200: ok, 202: aTrancher } = ROUTES_C1["clients-retrouver-ou-creer"].reponses;
    expect(ok.safeParse({ resultat: "cree", axiCli: AXI }).success).toBe(true);
    expect(ok.safeParse({ resultat: "a_trancher", idDemande: "d-1" }).success).toBe(false);
    expect(aTrancher.safeParse({ resultat: "a_trancher", idDemande: "d-1" }).success).toBe(true);
    expect(aTrancher.safeParse({ resultat: "retrouve", axiCli: AXI }).success).toBe(false);
  });

  it("[LOT0-c1] le motif de clôture et les statuts sont des vocabulaires fermés", () => {
    expect(CloreRequete.safeParse({ dateFin: "2027-01-31", motif: "fin_engagement" }).success).toBe(true);
    expect(CloreRequete.safeParse({ dateFin: "2027-01-31", motif: "fin d'engagement" }).success).toBe(false);
    expect(StatutsReponse.safeParse({ elements: [{ type: "facture", reference: "F-1", statut: "payee" }], curseur: "c-1" }).success).toBe(true);
    expect(StatutsReponse.safeParse({ elements: [{ type: "facture", reference: "F-1", statut: "signe" }], curseur: "c-1" }).success).toBe(false);
  });

  it("[LOT0-c1] rattrapage par curseur global opaque, jamais vide, avec limite de 500 et suite", () => {
    expect(RattrapageRequete.safeParse({ apres: "0" }).success).toBe(true);
    expect(RattrapageRequete.safeParse({ apres: "" }).success).toBe(false);
    expect(RattrapageRequete.safeParse({ apres: "c-42", limite: "500", axiCli: AXI }).success).toBe(true);
    expect(RattrapageRequete.safeParse({ apres: "c-42", limite: "501" }).success).toBe(false);
    expect(ROUTES_C1.faits.reponses[200].safeParse({ faits: [], suivant: "c-42", complet: true }).success).toBe(true);
    expect(ROUTES_C1.faits.reponses[200].safeParse({ faits: [] }).success).toBe(false);
  });

  it("[LOT0-c1] chaque écriture de C1 exige Idempotency-Key", () => {
    for (const [nom, r] of Object.entries(ROUTES_C1)) expect(r.antiDoublon, nom).toBe(r.methode === "POST" ? "idempotency_key" : "lecture");
  });
});
