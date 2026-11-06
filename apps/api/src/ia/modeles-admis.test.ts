import { describe, expect, it } from "vitest";
import { ErreurModele, exigerModeleAdmis, MODELE_DEFAUT, MODELES_ADMIS, modeleAdmis } from "./modeles-admis.ts";

describe("liste des modèles admis tenue par AXION IA (T4-34a)", () => {
  it("[C-198] un modèle absent de la liste tenue par AXION IA est refusé", () => {
    expect(() => exigerModeleAdmis("fournisseur-inconnu/modele-x")).toThrowError(ErreurModele);
    expect(() => exigerModeleAdmis("fournisseur-inconnu/modele-x")).toThrowError(/modele_non_admis/);
    // Un modèle retiré de la liste fait échouer proprement (attaque 4) : même refus, sans valeur de clé ni détail.
    const retiree = MODELES_ADMIS.filter((m) => m.code !== MODELE_DEFAUT);
    expect(() => exigerModeleAdmis(MODELE_DEFAUT, retiree)).toThrowError(/modele_non_admis/);
    // Un code mal formé n'est jamais admis, même s'il figurait dans une liste.
    expect(modeleAdmis("../secret", [{ code: "../secret", fournisseur: "x", horsUe: false }])).toBeUndefined();
  });

  it("[C-198] un modèle de la liste est admis, et le modèle par défaut est de l'UE", () => {
    expect(exigerModeleAdmis(MODELE_DEFAUT).horsUe).toBe(false);
    expect(MODELE_DEFAUT.startsWith("mistral")).toBe(true);
    expect(MODELES_ADMIS.length).toBeGreaterThan(1);
    expect(new Set(MODELES_ADMIS.map((m) => m.code)).size).toBe(MODELES_ADMIS.length);
  });
});
