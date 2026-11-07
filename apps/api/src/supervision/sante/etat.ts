import { MUETTE_APRES_MS } from "../mesures/cellules.js";
import type { Taux } from "../mesures/fenetres.js";

// Santé d'une instance (B-391 à B-393) : une fonction pure, des seuils écrits une seule fois ici.
// Les écrans et les tests importent SEUILS ; ils ne les recopient pas. L'état ne décide pas des alertes (B-483) : T5-04 et T5-06 le font.
export const SEUILS = {
  rougeSousPointsDeBase: 8_000,
  orangeSousPointsDeBase: 9_500,
  echecsDeSuite: 3,
  celluleMuetteMs: MUETTE_APRES_MS,
  coutIaPourcentBudget: 80,
  tachesEnAttente: 500,
  tachesEnAttenteMs: 600_000,
} as const;

export type EtatSante = "vert" | "orange" | "rouge";

export interface MesuresInstance {
  taux: Taux;
  echecsDeSuite: number;
  connexionExpiree: boolean;
  aucuneExecutionAttendue24h: boolean;
  celluleMuetteDepuisMs: number;
  enRetard: boolean;
  coutIaMicroCentimes: number;
  budgetIaMicroCentimes: number;
  tachesEnAttente: number;
  tachesEnAttenteDepuisMs: number;
}

export interface SanteInstance {
  etat: EtatSante;
  raisons: string[];
}

export function etatInstance(m: MesuresInstance): SanteInstance {
  const points = m.taux.etat === "mesure" ? m.taux.pointsDeBase : null;
  const rouges: [boolean, string][] = [
    [points !== null && points < SEUILS.rougeSousPointsDeBase, "succes_sous_80"],
    [m.echecsDeSuite >= SEUILS.echecsDeSuite, "echecs_de_suite"],
    [m.connexionExpiree, "connexion_expiree"],
    [m.aucuneExecutionAttendue24h, "aucune_execution_24h"],
    [m.celluleMuetteDepuisMs >= SEUILS.celluleMuetteMs, "cellule_muette"],
  ];
  const rouge = rouges.filter(([vrai]) => vrai).map(([, code]) => code);
  if (rouge.length > 0) return { etat: "rouge", raisons: rouge };
  const oranges: [boolean, string][] = [
    [points !== null && points < SEUILS.orangeSousPointsDeBase, "succes_sous_95"],
    [m.enRetard, "retard_frequence"],
    [m.budgetIaMicroCentimes > 0 && m.coutIaMicroCentimes * 100 > m.budgetIaMicroCentimes * SEUILS.coutIaPourcentBudget, "cout_ia_80"],
    [m.tachesEnAttente > SEUILS.tachesEnAttente && m.tachesEnAttenteDepuisMs >= SEUILS.tachesEnAttenteMs, "file_attente_500"],
  ];
  const orange = oranges.filter(([vrai]) => vrai).map(([, code]) => code);
  return orange.length > 0 ? { etat: "orange", raisons: orange } : { etat: "vert", raisons: [] };
}
