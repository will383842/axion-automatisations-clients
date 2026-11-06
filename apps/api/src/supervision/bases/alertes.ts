import type { MesureBase } from "./releve.js";

// Alertes tirées d'une mesure (A-263). Elles décrivent seulement la cause et la raison (codes) : l'ouverture dans la file est faite par T5-04.
export interface SeuilsBase {
  lignesMortesMax?: number; // [À DÉFINIR] : sans valeur, pas d'alerte
}
export interface AlerteMesure {
  cause: string;
  raison: string;
}

export function alertesBase(m: MesureBase, seuils: SeuilsBase): AlerteMesure[] {
  const alertes: AlerteMesure[] = [];
  if (m.limiteConnexions > 0 && m.connexions * 10 > m.limiteConnexions * 8) alertes.push({ cause: "base_saturee", raison: "connexions_80_pourcent" });
  if (seuils.lignesMortesMax !== undefined && m.lignesMortes > seuils.lignesMortesMax) alertes.push({ cause: "base_a_nettoyer", raison: "lignes_mortes_elevees" });
  return alertes;
}
