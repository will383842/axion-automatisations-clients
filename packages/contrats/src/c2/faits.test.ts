import { describe, expect, it } from "vitest";
import { TYPES_DE_FAITS, Fait } from "./faits.ts";

const base = {
  event_id: "11111111-1111-4111-8111-111111111111",
  schema_version: 1,
  occurred_at: "2026-10-24T10:00:00Z",
  emitted_at: "2026-10-24T10:00:01Z",
  producer: "axion-ia-hub",
  subject_ref: { axiCli: "AXI-CLI-000001" },
  sequence: 1,
};
const facture = {
  numeroFacture: "AXI-FACT-000001",
  nature: "abonnement",
  idPlan: "plan-1",
  debutPeriode: "2026-11-01",
  finPeriode: "2026-11-30",
  montantHtCentimes: 100,
  montantTvaCentimes: 20,
  montantTtcCentimes: 120,
  referenceAbonnementConsole: "abonnement-0001",
  dateEmission: "2026-10-24",
  dateEcheance: "2026-11-23",
  pdf: { url: "https://documents.exemple.fr/f1.pdf", expireAt: "2026-10-25T10:00:00Z", sha256: "a".repeat(64) },
};

describe("contrat C2", () => {
  it("[LOT0-c2] les 10 types de faits sont déclarés", () => {
    expect([...TYPES_DE_FAITS].sort()).toEqual(
      ["audit.cloture", "avoir.emis", "devis.expire", "devis.refuse", "devis.signe", "facture.emise", "fiche.fusion_annulee", "fiche.fusionnee", "paiement.recu", "relance.proposee"].sort(),
    );
  });

  it("[C-589] facture.emise d'abonnement sans debutPeriode refusée", () => {
    const ok = Fait.safeParse({ ...base, event_type: "facture.emise", payload: facture });
    expect(ok.success).toBe(true);
    const sans: Record<string, unknown> = { ...facture };
    delete sans.debutPeriode;
    expect(Fait.safeParse({ ...base, event_type: "facture.emise", payload: sans }).success).toBe(false);
  });

  it("[LOT0-c2] un event_id qui n'est pas un UUID v4 est refusé, les noms du fil sont en snake_case", () => {
    expect(Fait.safeParse({ ...base, event_id: "pas-un-uuid", event_type: "facture.emise", payload: facture }).success).toBe(false);
    expect(Fait.safeParse({ ...base, eventId: base.event_id, event_type: "facture.emise", payload: facture }).success).toBe(false);
  });

  it("[C-589] la règle de période passe par l'union par nature : sans période, seule une facture hors abonnement est valide", () => {
    const { debutPeriode: _d, finPeriode: _f, ...sansPeriode } = facture;
    const emise = (payload: unknown) => Fait.safeParse({ ...base, event_type: "facture.emise", payload }).success;
    expect(emise({ ...sansPeriode, nature: "mise_en_place", idBrouillon: "brouillon-0001", referenceBonDeCommande: "bdc-0001" })).toBe(true);
    expect(emise({ ...facture, debutPeriode: "2026-12-01" })).toBe(false);
  });

  it("[LOT0-c2] stockage et solde_engagement sont des natures connues de la console (récepteur d'abord)", () => {
    for (const nature of ["stockage", "solde_engagement"]) expect(Fait.safeParse({ ...base, event_type: "facture.emise", payload: { ...facture, nature } }).success, nature).toBe(true);
  });

  it("[LOT0-c2] facture groupée : une ligne par abonnement avec sa propre période, son terme et sa TVA", () => {
    const ligne = (ref: string, fin: string, mois: number, montant: number) => ({
      referenceAbonnementConsole: ref, codeAutomatisation: "tri-courriels", libelle: "Automatisation d'essai", debutPeriode: "2026-11-01", finPeriode: fin, periodeMois: mois, terme: "a_echoir", montantHtCentimes: montant, tauxTvaBps: 2000,
    });
    const groupee = { ...facture, finPeriode: "2027-01-31", lignes: [ligne("abonnement-0001", "2026-11-30", 1, 40), ligne("abonnement-0002", "2027-01-31", 3, 60)] };
    expect(Fait.safeParse({ ...base, event_type: "facture.emise", payload: groupee }).success).toBe(true);
    const sansTerme = { ...groupee, lignes: [{ ...ligne("abonnement-0001", "2026-11-30", 1, 40), terme: "plus_tard" }] };
    expect(Fait.safeParse({ ...base, event_type: "facture.emise", payload: sansTerme }).success).toBe(false);
  });

  it("[LOT0-c2] montants : HT + TVA = TTC, jamais négatifs, avoir en montant positif", () => {
    expect(Fait.safeParse({ ...base, event_type: "facture.emise", payload: { ...facture, montantTtcCentimes: 121 } }).success).toBe(false);
    const avoir = { numeroAvoir: "AXI-AVOIR-000001", numeroFactureOrigine: "AXI-FACT-000001", montantHtCentimes: 100 };
    expect(Fait.safeParse({ ...base, event_type: "avoir.emis", payload: avoir }).success).toBe(true);
    expect(Fait.safeParse({ ...base, event_type: "avoir.emis", payload: { ...avoir, montantHtCentimes: -100 } }).success).toBe(false);
  });

  it("[LOT0-c2] audit.cloture : le SIREN suit la même règle que C3 (Luhn)", () => {
    const audit = { siren: "812345676", contact: { nom: "Camille Test", email: "contact@exemple.fr" }, typeAudit: "diagnostic_distance", dateAudit: "2026-10-20", outils: [], besoins: [], lienCompteRendu: "https://documents.exemple.fr/cr" };
    expect(Fait.safeParse({ ...base, event_type: "audit.cloture", payload: audit }).success).toBe(true);
    expect(Fait.safeParse({ ...base, event_type: "audit.cloture", payload: { ...audit, siren: "123456789" } }).success).toBe(false);
  });
});
