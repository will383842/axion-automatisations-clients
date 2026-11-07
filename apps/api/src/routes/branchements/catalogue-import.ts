import { routeImportCatalogue, type DepsImportCatalogue } from "../catalogue/import.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    importCatalogue: DepsImportCatalogue;
  }
}

// Import des versions (T4-25) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert` est faux (IMPORT_OUVERT, fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeImportCatalogue(appli, { ouvert: false, importeur: VIDE, authentifier: GARDE_VIDE }),
  serveur: surCle("importCatalogue", routeImportCatalogue),
};

export default branchement;
