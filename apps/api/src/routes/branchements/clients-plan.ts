import { routePlan, type DepsPlan } from "../clients/plan.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    planClient: DepsPlan;
  }
}

// Plan enregistré d'un client (T3-14a) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routePlan(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, session: VIDE, lire: VIDE }),
  serveur: surCle("planClient", routePlan),
};

export default branchement;
