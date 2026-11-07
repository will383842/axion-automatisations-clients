import { routeImport, type DepsImport } from "../import.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    importPersonnes: DepsImport;
  }
}

// Import de personnes (T2-47b) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeImport(appli, { ouvert: false, session: VIDE, ports: VIDE }),
  serveur: surCle("importPersonnes", routeImport),
};

export default branchement;
