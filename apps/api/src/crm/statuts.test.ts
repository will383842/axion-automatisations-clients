import { describe, expect, it } from "vitest";
import { STATUTS_CRM_DEPUIS_CONSOLE, statutCrmDepuisConsole } from "./statuts.ts";

describe("correspondance des statuts console et CRM", () => {
  it("[C-324] la correspondance des statuts Hub et CRM suit la table du contrat, case par case", () => {
    expect(statutCrmDepuisConsole("prospect")).toEqual({ crm: "prospect", fait: null });
    // Révision du 27/10/2026 : tant que le contrat n'est pas signé, le CRM voit « prospect » et aucun fait ne part.
    expect(statutCrmDepuisConsole("en_signature")).toEqual({ crm: "prospect", fait: null });
    expect(statutCrmDepuisConsole("client")).toEqual({ crm: "client", fait: "client" });
    expect(statutCrmDepuisConsole("ancien_client")).toEqual({ crm: "perdu", fait: "perdu" });
  });
  it("[C-324] dormant n'existe que côté CRM : aucun statut de la console n'y mène", () => {
    expect(Object.values(STATUTS_CRM_DEPUIS_CONSOLE).map((l) => l.fait)).not.toContain("dormant");
    expect(Object.keys(STATUTS_CRM_DEPUIS_CONSOLE).sort()).toEqual(["ancien_client", "client", "en_signature", "prospect"]);
  });
});
