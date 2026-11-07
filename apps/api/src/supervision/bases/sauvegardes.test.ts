import { describe, expect, it } from "vitest";
import { alerteSauvegarde } from "./sauvegardes.js";

describe("âge des sauvegardes", () => {
  it("[B-493] sauvegarde plus vieille que le délai toléré → alerte sauvegarde_echec", () => {
    expect(alerteSauvegarde({ ageSauvegardeS: 90_000, ageTestRestaurationS: 100 }, { sauvegardeMaxS: 86_400, restaurationMaxS: 2_592_000 })).toEqual({ cause: "sauvegarde_echec", raison: "sauvegarde_trop_ancienne" });
  });
  it("[B-493] test de restauration trop ancien → même cause, autre raison", () => {
    expect(alerteSauvegarde({ ageSauvegardeS: 100, ageTestRestaurationS: 3_000_000 }, { sauvegardeMaxS: 86_400, restaurationMaxS: 2_592_000 })).toEqual({ cause: "sauvegarde_echec", raison: "restauration_non_testee" });
  });
  it("[B-493] aucune sauvegarde du tout est une alerte, pas un silence", () => {
    expect(alerteSauvegarde({ ageSauvegardeS: null, ageTestRestaurationS: null }, { sauvegardeMaxS: 86_400, restaurationMaxS: 2_592_000 })?.raison).toBe("aucune_sauvegarde");
  });
  it("[B-493] sans seuil configuré aucune alerte n'est inventée", () => {
    expect(alerteSauvegarde({ ageSauvegardeS: 999_999_999, ageTestRestaurationS: null }, {})).toBeNull();
  });
  it("[B-493] tout est à jour → rien", () => {
    expect(alerteSauvegarde({ ageSauvegardeS: 100, ageTestRestaurationS: 100 }, { sauvegardeMaxS: 86_400, restaurationMaxS: 2_592_000 })).toBeNull();
  });
});
