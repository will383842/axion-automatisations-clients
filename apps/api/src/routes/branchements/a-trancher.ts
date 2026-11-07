import { routeATrancher } from "../a-trancher.js";
import { VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => routeATrancher(appli, { exigerEquipe: GARDE_VIDE, appelant: VIDE, reauthentifie: VIDE, appliquer: VIDE, ecarter: VIDE }),
};

export default branchement;
