import { routeDonneesModule } from "../portail/donnees-module.js";
import { VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => routeDonneesModule(appli, VIDE),
};

export default branchement;
