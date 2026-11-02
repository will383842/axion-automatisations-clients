import { describe, expect, it } from "vitest";
import { lireMode } from "./modes.ts";

describe("modes de l'exécuteur", () => {
  it("[A-012] mode relie refusé au démarrage en V1", () => {
    expect(() => lireMode({ EXECUTEUR_MODE: "relie" })).toThrow(/V2/);
  });
  it("[A-284] mode autonome refusé au démarrage en V1, et toute valeur inconnue aussi", () => {
    expect(() => lireMode({ EXECUTEUR_MODE: "autonome" })).toThrow(/V2/);
    expect(() => lireMode({ EXECUTEUR_MODE: "autre" })).toThrow(/inconnu/);
    expect(() => lireMode({ EXECUTEUR_MODE: "" })).toThrow(/inconnu/);
  });
  it("[A-012] le mode mutualise est accepté, et c'est le défaut : le mode est un réglage, pas une autre image", () => {
    expect(lireMode({ EXECUTEUR_MODE: "mutualise" })).toBe("mutualise");
    expect(lireMode({})).toBe("mutualise");
  });
});
