import { routeOutils, type DepsOutils } from "../clients/outils.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    outils: DepsOutils;
  }
}

// Outils du client et compatibilité (T3-17b) : même règle, 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeOutils(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, droits: VIDE, depot: VIDE }),
  serveur: surCle("outils", routeOutils),
};

export default branchement;
