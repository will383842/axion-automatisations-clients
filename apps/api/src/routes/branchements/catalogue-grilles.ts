import { routeGrillesCatalogue, type DepsGrillesCatalogue } from "../catalogue/grilles.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    grillesCatalogue: DepsGrillesCatalogue;
  }
}

// Grille de prix du catalogue (T3-31a1) : les routes n'existent que si l'appelant les fournit, 503 tant que `ouvert` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeGrillesCatalogue(appli, { ouvert: false, exigerEquipe: GARDE_VIDE, exigerReauthentification: GARDE_VIDE, droits: VIDE, acteur: VIDE, service: VIDE }),
  serveur: surCle("grillesCatalogue", routeGrillesCatalogue),
};

export default branchement;
