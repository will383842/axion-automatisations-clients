import { describe, expect, it } from "vitest";
import { CLASSES_ERREUR, POLITIQUES } from "./erreurs.ts";
import { GARANTIES } from "./effets.ts";

describe("effets et erreurs (C4 v0)", () => {
  it("[LOT0-c4] les trois garanties d'effet externe sont déclarées", () => {
    expect([...GARANTIES]).toEqual(["idempotent_par_cle", "verifiable_apres_coup", "au_plus_une_fois"]);
  });

  it("[LOT0-c4] les quatre classes d'erreur ont chacune leur politique", () => {
    expect([...CLASSES_ERREUR]).toEqual(["passagere", "quota", "identification", "definitive"]);
    expect(POLITIQUES.passagere).toEqual({ essais: 5, attente: "croissante_avec_alea" });
    expect(POLITIQUES.quota).toEqual({ attente: "date_de_l_outil" });
    expect(POLITIQUES.identification).toEqual({ connexion: "rouge", instance: "pause" });
    expect(POLITIQUES.definitive).toEqual({ evenement: "erreur" });
  });
});
