import { routeListeCatalogue, type DepsListeCatalogue } from "../catalogue/liste.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    listeCatalogue: DepsListeCatalogue;
  }
}

// Liste, recherche et doublons du catalogue (T3-40a) : les routes n'existent que si l'appelant les fournit, 503 tant que `ouvert` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeListeCatalogue(appli, { ouvert: false, exigerEquipe: GARDE_VIDE, droits: VIDE, acteur: VIDE, service: VIDE }),
  serveur: surCle("listeCatalogue", routeListeCatalogue),
};

export default branchement;
