import { routeSante } from "../sante.js";
import { type Branchement } from "../branchement.js";

// Santé : toujours branchée.
const branchement: Branchement = {
  lister: (appli) => routeSante(appli),
  serveur: { toujours: true, brancher: routeSante },
};

export default branchement;
