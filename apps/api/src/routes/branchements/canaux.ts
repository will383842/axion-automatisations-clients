import { routeCanaux } from "../canaux.js";
import { VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => routeCanaux(appli, { exigerEquipe: GARDE_VIDE, magasin: VIDE }),
};

export default branchement;
