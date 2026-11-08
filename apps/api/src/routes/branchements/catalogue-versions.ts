import { routeVersionsCatalogue, type DepsVersionsCatalogue } from "../catalogue/versions.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    versionsCatalogue: DepsVersionsCatalogue;
  }
}

// Cycle de vie des versions (T4-27b) : la route n'existe que si l'appelant la fournit, réservée à l'équipe, et répond 503 tant que `ouvert` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeVersionsCatalogue(appli, { ouvert: false, cycle: VIDE, authentifier: GARDE_VIDE }),
  serveur: surCle("versionsCatalogue", routeVersionsCatalogue),
};

export default branchement;
