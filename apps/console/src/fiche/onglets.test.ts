import { describe, expect, it } from "vitest";
import { ONGLETS_FICHE, ongletsLivres } from "./onglets.ts";

describe("registre des onglets de la fiche", () => {
  it("[B-002] la fiche regroupe tous les onglets prévus, et seuls les onglets livrés apparaissent", () => {
    expect(ONGLETS_FICHE.map((o) => o.cle)).toEqual(expect.arrayContaining(["resume", "contrat", "automatisations", "reglages", "outils", "ia", "sante", "donnees", "demandes", "utilisateurs", "notes", "journal", "conformite", "visibilite", "factures"]));
    expect(ongletsLivres().map((o) => o.cle)).toEqual(["resume", "notes"]);
    expect(ongletsLivres()[0]?.cle).toBe("resume");
    expect(new Set(ONGLETS_FICHE.map((o) => o.cle)).size).toBe(ONGLETS_FICHE.length);
  });
});
