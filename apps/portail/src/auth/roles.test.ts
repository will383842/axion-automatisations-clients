import { describe, expect, it } from "vitest";
import * as ecran from "./roles.ts";
import * as api from "../../../api/src/portail/roles.ts";
import { rubriquesVisibles } from "./garde.ts";

describe("écran du portail", () => {
  it("[LOT6-roles] l'écran et l'API lisent la même liste (même référence d'objet)", () => {
    expect(ecran.RUBRIQUES).toBe(api.RUBRIQUES);
    expect(ecran.LECTURE_EN_POST).toBe(api.LECTURE_EN_POST);
  });

  it("[LOT6-roles] l'écran cache les rubriques refusées au rôle (comptable : factures et documents seulement)", () => {
    expect(rubriquesVisibles("comptable").sort()).toEqual(["documents", "factures", "forfaits", "mon-compte", "mon-entreprise/facturation"]);
    expect(rubriquesVisibles("administrateur")).toContain("equipe");
  });
});
