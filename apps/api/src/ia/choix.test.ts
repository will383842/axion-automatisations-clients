import { describe, expect, it } from "vitest";
import { choisirModele } from "./choix.js";
import { ErreurModele, MODELE_DEFAUT, MODELES_ADMIS } from "./modeles-admis.js";

const HORS_UE = MODELES_ADMIS.find((m) => m.horsUe)?.code ?? "absent";
const DANS_UE = MODELES_ADMIS.find((m) => !m.horsUe && m.code !== MODELE_DEFAUT)?.code ?? MODELE_DEFAUT;
const base = { refusHorsUe: false, defautClient: null, surcharge: null };

describe("choix du modèle d'IA (T4-34a)", () => {
  it("[C-067] client « hors UE refusé » : défaut Mistral et refus d'un modèle hors UE", () => {
    expect(HORS_UE).not.toBe("absent");
    expect(choisirModele({ ...base, refusHorsUe: true })).toBe(MODELE_DEFAUT);
    // Défaut du client, surcharge d'instance et réglage du module : les trois sont refusés s'ils sortent de l'UE (attaque 3).
    expect(() => choisirModele({ ...base, refusHorsUe: true, defautClient: HORS_UE })).toThrowError(/hors_ue_refuse/);
    expect(() => choisirModele({ ...base, refusHorsUe: true, surcharge: HORS_UE })).toThrowError(/hors_ue_refuse/);
    expect(() => choisirModele({ ...base, refusHorsUe: true, reglageModule: HORS_UE })).toThrowError(ErreurModele);
    // Sans refus, le même modèle passe.
    expect(choisirModele({ ...base, surcharge: HORS_UE })).toBe(HORS_UE);
  });

  it("[A-162] la surcharge par automatisation remplace le défaut du client", () => {
    expect(choisirModele({ ...base, defautClient: MODELE_DEFAUT })).toBe(MODELE_DEFAUT);
    expect(choisirModele({ ...base, defautClient: MODELE_DEFAUT, surcharge: DANS_UE })).toBe(DANS_UE);
    // Sans défaut ni surcharge : le défaut d'AXION IA.
    expect(choisirModele(base)).toBe(MODELE_DEFAUT);
  });

  it("[C-198] un modèle choisi hors liste, ou hors des modèles déclarés par le module, est refusé", () => {
    expect(() => choisirModele({ ...base, surcharge: "fournisseur-inconnu/x" })).toThrowError(/modele_non_admis/);
    expect(() => choisirModele({ ...base, surcharge: DANS_UE, modelesDuModule: [MODELE_DEFAUT] })).toThrowError(/hors_manifeste/);
    expect(choisirModele({ ...base, surcharge: DANS_UE, modelesDuModule: [MODELE_DEFAUT, DANS_UE] })).toBe(DANS_UE);
  });
});
