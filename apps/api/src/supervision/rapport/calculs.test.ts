import { describe, expect, it } from "vitest";
import { calculerMesures, formaterMinutes, moisPrecedent, type AgregatJour, type EntreeInstance } from "./calculs.js";

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";
const MOIS = "2026-10";

const jour = (tenantId: string, j: string, nombre: number, echecs = 0): AgregatJour => ({ tenantId, jour: j, nombre, echecs });
const inst = (tenantId: string, p: Partial<EntreeInstance> = {}): EntreeInstance => ({
  tenantId, code: "relances-devis", libelle: "Relances de devis", minutesParElement: 6, agregats: [], ...p,
});

describe("calculs du rapport mensuel", () => {
  it("[A-027] heures gagnées = éléments × minutes du cadrage (50 éléments × 6 min = 5 h 00), en minutes entières", () => {
    const m = calculerMesures(TA, [inst(TA, { agregats: [jour(TA, "2026-10-03", 20), jour(TA, "2026-10-15", 30)] })], MOIS);
    expect(m.heures).toEqual({ etat: "mesure", minutes: 300 });
    expect(m.instances[0]?.heures).toEqual({ etat: "mesure", minutes: 300 });
    expect(formaterMinutes(300)).toBe("5 h 00");
    expect(formaterMinutes(95)).toBe("1 h 35");
  });

  it("[A-027] sans cadrage pour la version courante, les heures sont « non calculées », jamais 0 ni minutes_gagnees", () => {
    const m = calculerMesures(TA, [inst(TA, { minutesParElement: null, agregats: [jour(TA, "2026-10-03", 20)] })], MOIS);
    expect(m.heures).toEqual({ etat: "non_calcule" });
    expect(m.cumulHeures).toEqual({ etat: "non_calcule" });
    expect(m.instances[0]?.heures).toEqual({ etat: "non_calcule" });
    expect(m.instancesNonCalculees).toBe(1);
    expect(m.volume).toBe(20);
  });

  it("[B-369] cumul depuis l'activation : somme de tous les agrégats jusqu'au dernier jour du mois inclus, mois vides compris, jour suivant exclu", () => {
    const m = calculerMesures(TA, [inst(TA, { agregats: [
      jour(TA, "2026-07-10", 10), // mois vide ensuite (août), puis septembre vide
      jour(TA, "2026-10-01", 5),
      jour(TA, "2026-10-31", 5), // dernier jour inclus
      jour(TA, "2026-11-01", 100), // jour suivant exclu
    ] })], MOIS);
    expect(m.volume).toBe(10);
    expect(m.cumulHeures).toEqual({ etat: "mesure", minutes: 20 * 6 });
    expect(m.heures).toEqual({ etat: "mesure", minutes: 60 });
  });

  it("[B-408] fiabilité en points de base ; mois sans exécution → sans objet", () => {
    const m = calculerMesures(TA, [inst(TA, { agregats: [jour(TA, "2026-10-02", 20, 1)] })], MOIS);
    expect(m.fiabilite).toEqual({ etat: "mesure", pointsDeBase: 9500 });
    const vide = calculerMesures(TA, [inst(TA)], MOIS);
    expect(vide.fiabilite).toEqual({ etat: "sans_objet" });
    expect(vide.volume).toBe(0);
  });

  it("[B-408] comparaison : mois précédent vide → sans objet, jamais division par zéro ni « +100 % »", () => {
    const sans = calculerMesures(TA, [inst(TA, { agregats: [jour(TA, "2026-10-02", 20)] })], MOIS);
    expect(sans.comparaison).toEqual({ etat: "sans_objet" });
    const avec = calculerMesures(TA, [inst(TA, { agregats: [jour(TA, "2026-09-02", 10), jour(TA, "2026-10-02", 15)] })], MOIS);
    expect(avec.comparaison).toEqual({ etat: "mesure", ecartVolume: 5, evolutionVolumePointsDeBase: 5000, ecartMinutes: 30 });
    expect(moisPrecedent("2026-01")).toBe("2025-12");
  });

  it("[B-408] @isolation un agrégat ou une instance d'un autre client fait échouer le calcul, rien n'est mélangé", () => {
    expect(() => calculerMesures(TA, [inst(TA, { agregats: [jour(TB, "2026-10-02", 3)] })], MOIS)).toThrow();
    expect(() => calculerMesures(TA, [inst(TB)], MOIS)).toThrow();
  });

  it("[B-408] entrées invalides : mois mal formé, jour mal formé, échecs supérieurs au nombre", () => {
    expect(() => calculerMesures(TA, [], "2026-13")).toThrow();
    expect(() => calculerMesures(TA, [inst(TA, { agregats: [jour(TA, "2026-10-2", 1)] })], MOIS)).toThrow();
    expect(() => calculerMesures(TA, [inst(TA, { agregats: [jour(TA, "2026-10-02", 1, 2)] })], MOIS)).toThrow();
  });
});
