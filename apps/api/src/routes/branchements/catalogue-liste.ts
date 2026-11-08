import { routeListeCatalogue, type DepsListeCatalogue } from "../catalogue/liste.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    listeCatalogue: DepsListeCatalogue;
  }
}

// Liste du catalogue de l'équipe (T3-31a2) : fermée par défaut, branchée seulement si l'appelant la fournit.
const branchement: Branchement = {
  lister: (appli) => routeListeCatalogue(appli, { ouvert: false, exigerEquipe: GARDE_VIDE, droits: VIDE, service: VIDE }),
  serveur: surCle("listeCatalogue", routeListeCatalogue),
};

export default branchement;
