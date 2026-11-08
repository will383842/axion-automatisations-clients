import { routeReglages } from "../reglages.js";
import { VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => routeReglages(appli, { exigerEquipe: GARDE_VIDE, contexte: VIDE, historique: VIDE, modifier: VIDE, revenir: VIDE }),
};

export default branchement;
