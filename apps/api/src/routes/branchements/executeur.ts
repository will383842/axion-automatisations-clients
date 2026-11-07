import { routeExecuteur, type DepsExecuteur } from "../executeur/index.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    executeur: DepsExecuteur;
  }
}

// API de l'exécuteur (C4) : absente sans dépendances ; fournie, la porte reste fermée tant que actif() rend faux (EXECUTEUR_API_OUVERTE, fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeExecuteur(appli, { actif: () => false, cles: VIDE, memoire: VIDE, depot: VIDE, evenements: { depot: VIDE } }),
  serveur: surCle("executeur", routeExecuteur),
};

export default branchement;
