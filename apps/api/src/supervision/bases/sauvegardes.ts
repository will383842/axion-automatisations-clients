// Âge de la dernière sauvegarde et du dernier test de restauration (B-493) contre les délais tolérés.
// Les délais sont des variables de configuration SANS valeur par défaut (SEUILS-A-DEFINIR, fixés au lot 8a) : sans seuil, aucune alerte n'est inventée.
export interface AgesSauvegarde {
  ageSauvegardeS: number | null;
  ageTestRestaurationS: number | null;
}
export interface SeuilsSauvegarde {
  sauvegardeMaxS?: number;
  restaurationMaxS?: number;
}
export interface AlerteBase {
  cause: string;
  raison: string;
}

export function alerteSauvegarde(ages: AgesSauvegarde, seuils: SeuilsSauvegarde): AlerteBase | null {
  const cause = "sauvegarde_echec";
  if (seuils.sauvegardeMaxS !== undefined) {
    if (ages.ageSauvegardeS === null) return { cause, raison: "aucune_sauvegarde" };
    if (ages.ageSauvegardeS > seuils.sauvegardeMaxS) return { cause, raison: "sauvegarde_trop_ancienne" };
  }
  if (seuils.restaurationMaxS !== undefined && ages.ageSauvegardeS !== null && (ages.ageTestRestaurationS === null || ages.ageTestRestaurationS > seuils.restaurationMaxS)) {
    return { cause, raison: "restauration_non_testee" };
  }
  return null;
}
