import { routeConnexions, type DepsConnexions } from "../clients/connexions.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    connexions: DepsConnexions;
  }
}

// Connexions d'un client (T3-17a) : lecture seule, la route n'existe que si l'appelant la fournit, 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeConnexions(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, droits: VIDE, session: VIDE, lire: VIDE }),
  serveur: surCle("connexions", routeConnexions),
};

export default branchement;
