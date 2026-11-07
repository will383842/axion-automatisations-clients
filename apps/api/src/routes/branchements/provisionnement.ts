import { routeProvisionnement, type DepsRoutesProvisionnement } from "../provisionnement.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    provisionnement: DepsRoutesProvisionnement;
  }
}

// `provisionnement` : routes de reprise fournies par l'appelant ; absent, la route n'existe pas (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeProvisionnement(appli, { exigerEquipe: GARDE_VIDE, etatBase: VIDE, reprendre: VIDE }),
  serveur: surCle("provisionnement", routeProvisionnement),
};

export default branchement;
