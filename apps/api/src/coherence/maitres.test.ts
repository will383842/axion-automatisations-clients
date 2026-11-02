import { describe, expect, it } from "vitest";
import { MAITRES, maitreDe } from "./maitres.js";

describe("table des maîtres", () => {
  it("[C-362] la table des maîtres est fermée : valeurs figées, aucun type ajouté sans changer ce test", () => {
    expect(Object.isFrozen(MAITRES)).toBe(true);
    expect(Object.keys(MAITRES).sort()).toEqual(["acces", "automatisations", "demandes", "devis", "echanges", "executions", "factures", "formule", "paiements", "plan_commercial", "prospect", "renouvellements", "statut_client", "visibilite"]);
    expect(() => maitreDe("inconnu" as never)).toThrow();
  });

  it("[C-095] le statut du client a la console pour maître ; prospect et échanges le CRM ; devis, factures et paiements le Hub", () => {
    expect(maitreDe("statut_client")).toBe("console");
    expect([maitreDe("prospect"), maitreDe("echanges")]).toEqual(["crm", "crm"]);
    expect([maitreDe("devis"), maitreDe("factures"), maitreDe("paiements")]).toEqual(["hub", "hub", "hub"]);
  });

  it("[C-343] la console est maître des automatisations, exécutions, demandes, formule, plan commercial, renouvellements, visibilité et accès", () => {
    for (const t of ["automatisations", "executions", "demandes", "formule", "plan_commercial", "renouvellements", "visibilite", "acces"] as const) expect(maitreDe(t), t).toBe("console");
  });
});
