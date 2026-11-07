import { routeJournal, routeAnnulation } from "../journal.js";
import { VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => {
    routeJournal(appli, { exigerEquipe: GARDE_VIDE, lire: VIDE });
    routeAnnulation(appli, { exigerEquipe: GARDE_VIDE, contexte: VIDE, annuler: VIDE });
  },
};

export default branchement;
