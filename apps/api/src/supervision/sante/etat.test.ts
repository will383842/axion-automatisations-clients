import { describe, expect, it } from "vitest";
import { etatInstance, type MesuresInstance } from "./etat.js";

const sain: MesuresInstance = {
  taux: { etat: "mesure", pointsDeBase: 9_500, total: 20, echecs: 1 },
  echecsDeSuite: 0, connexionExpiree: false, aucuneExecutionAttendue24h: false, celluleMuetteDepuisMs: 0,
  enRetard: false, coutIaMicroCentimes: 0, budgetIaMicroCentimes: 0, tachesEnAttente: 0, tachesEnAttenteDepuisMs: 0,
};
const avec = (p: Partial<MesuresInstance>): MesuresInstance => ({ ...sain, ...p });
const taux = (pointsDeBase: number) => ({ etat: "mesure" as const, pointsDeBase, total: 100, echecs: 0 });

describe("état d'une instance", () => {
  it("[B-391] 9 500 points de base, à l'heure, connexions valides → vert", () => {
    expect(etatInstance(sain)).toEqual({ etat: "vert", raisons: [] });
  });
  it("[B-392] 9 499 → orange", () => {
    expect(etatInstance(avec({ taux: taux(9_499) }))).toEqual({ etat: "orange", raisons: ["succes_sous_95"] });
  });
  it("[B-392] 8 000 → orange (le bord de 80 % est orange)", () => {
    expect(etatInstance(avec({ taux: taux(8_000) })).etat).toBe("orange");
  });
  it("[B-393] 7 999 → rouge", () => {
    expect(etatInstance(avec({ taux: taux(7_999) }))).toEqual({ etat: "rouge", raisons: ["succes_sous_80"] });
  });
  it("[B-393] 3 échecs de suite → rouge même à 96 %", () => {
    expect(etatInstance(avec({ taux: taux(9_600), echecsDeSuite: 3 }))).toEqual({ etat: "rouge", raisons: ["echecs_de_suite"] });
    expect(etatInstance(avec({ taux: taux(9_600), echecsDeSuite: 2 })).etat).toBe("vert");
  });
  it("[B-393] connexion expirée, aucune exécution en 24 h, cellule muette 10 min → rouge", () => {
    expect(etatInstance(avec({ connexionExpiree: true })).raisons).toEqual(["connexion_expiree"]);
    expect(etatInstance(avec({ aucuneExecutionAttendue24h: true })).raisons).toEqual(["aucune_execution_24h"]);
    expect(etatInstance(avec({ celluleMuetteDepuisMs: 600_000 }))).toEqual({ etat: "rouge", raisons: ["cellule_muette"] });
    expect(etatInstance(avec({ celluleMuetteDepuisMs: 599_999 })).etat).toBe("vert");
  });
  it("[B-393] le rouge garde toutes ses raisons, dans l'ordre de la règle", () => {
    expect(etatInstance(avec({ taux: taux(7_000), echecsDeSuite: 4, connexionExpiree: true })).raisons).toEqual(["succes_sous_80", "echecs_de_suite", "connexion_expiree"]);
  });
  it("[B-392] sans exécution attendue (sans objet), le taux ne dégrade pas l'état", () => {
    expect(etatInstance(avec({ taux: { etat: "sans_objet" } })).etat).toBe("vert");
  });
  it("[B-392] un retard de plus de 2 fois la fréquence → orange", () => {
    expect(etatInstance(avec({ enRetard: true }))).toEqual({ etat: "orange", raisons: ["retard_frequence"] });
  });
  it("[B-392] 501 tâches pendant 10 min → orange, 501 pendant 9 min → vert, 500 pendant 10 min → vert", () => {
    expect(etatInstance(avec({ tachesEnAttente: 501, tachesEnAttenteDepuisMs: 600_000 })).raisons).toEqual(["file_attente_500"]);
    expect(etatInstance(avec({ tachesEnAttente: 501, tachesEnAttenteDepuisMs: 540_000 })).etat).toBe("vert");
    expect(etatInstance(avec({ tachesEnAttente: 500, tachesEnAttenteDepuisMs: 600_000 })).etat).toBe("vert");
  });
  it("[B-386] coût à 80,01 % du budget → orange, à 80,00 % → vert", () => {
    expect(etatInstance(avec({ budgetIaMicroCentimes: 10_000, coutIaMicroCentimes: 8_001 })).raisons).toEqual(["cout_ia_80"]);
    expect(etatInstance(avec({ budgetIaMicroCentimes: 10_000, coutIaMicroCentimes: 8_000 })).etat).toBe("vert");
  });
  it("[C-660] 80 % du volume effectif d'IA (fixture) : santé orange, une seule raison de coût", () => {
    const r = etatInstance(avec({ budgetIaMicroCentimes: 1_000, coutIaMicroCentimes: 801 }));
    expect(r.etat).toBe("orange");
    expect(r.raisons.filter((c) => c.startsWith("cout_ia"))).toHaveLength(1);
  });
});
