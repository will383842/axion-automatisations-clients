import { brancherHub } from "../hub.js";
import { VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas aujourd'hui.
const branchement: Branchement = {
  lister: (appli) => {
    const entrant = { cles: VIDE, memoire: VIDE, actif: () => false };
    brancherHub(appli, { entrant, recepteur: { alerter: () => undefined } as never });
  },
};

export default branchement;
