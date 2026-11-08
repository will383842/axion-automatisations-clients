import { routeDonnees, type DepsRoutesDonnees } from "../donnees.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    donnees: DepsRoutesDonnees;
  }
}

// Service des données (T2-37c) : branché seulement si l'appelant fournit la session, le rôle d'équipe et le service ; absent, la route n'existe pas.
const branchement: Branchement = {
  lister: (appli) => routeDonnees(appli, VIDE),
  serveur: surCle("donnees", routeDonnees),
};

export default branchement;
