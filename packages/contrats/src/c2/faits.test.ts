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
    expect(Fait.safeParse({ ...base, eventId: base.event_id, event_type: "facture.emise", payload: facture }).success).toBe(true);
  });
});
