import { SEUILS } from "./etat.js";

// Phrases simples pour les raisons d'un état. Les seuils viennent de SEUILS.
const LIBELLES: Record<string, string> = {
  succes_sous_80: `Moins de ${SEUILS.rougeSousPointsDeBase / 100} % de réussites sur 24 h`,
  echecs_de_suite: `${SEUILS.echecsDeSuite} échecs de suite`,
  connexion_expiree: "La connexion du client a expiré",
  aucune_execution_24h: "Aucune exécution depuis 24 h alors qu'une était attendue",
  cellule_muette: `La cellule ne répond plus depuis ${SEUILS.celluleMuetteMs / 60_000} minutes`,
  succes_sous_95: `Moins de ${SEUILS.orangeSousPointsDeBase / 100} % de réussites sur 24 h`,
  retard_frequence: "Plus de 2 fois la fréquence habituelle sans réussite",
  cout_ia_80: `Coût d'IA au-delà de ${SEUILS.coutIaPourcentBudget} % du budget`,
  file_attente_500: `Plus de ${SEUILS.tachesEnAttente} tâches en attente depuis ${SEUILS.tachesEnAttenteMs / 60_000} minutes`,
};

export function libelleRaison(code: string): string {
  return LIBELLES[code] ?? "Raison non décrite";
}
