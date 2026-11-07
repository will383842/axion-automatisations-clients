import { routeGel } from "../gel.js";
import { VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => routeGel(appli, { exigerEquipe: GARDE_VIDE, exigerReauthentification: GARDE_VIDE, session: VIDE, gel: VIDE }),
};

export default branchement;
