import { routeFiche, type DepsFiche } from "../clients/fiche.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    fiche: DepsFiche;
  }
}

// Fiche client (T3-13) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeFiche(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, session: VIDE, lire: VIDE }),
  serveur: surCle("fiche", routeFiche),
};

export default branchement;
