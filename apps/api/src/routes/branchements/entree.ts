import { routeEntree } from "../entree.js";
import { VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => routeEntree(appli, { cles: VIDE, memoire: VIDE, alertes: VIDE, connexionNormale: "/connexion" }),
};

export default branchement;
