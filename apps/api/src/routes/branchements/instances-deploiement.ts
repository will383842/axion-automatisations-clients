import { routeDeploiementInstances, type DepsDeploiementInstances } from "../instances/deploiement.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    deploiementInstances: DepsDeploiementInstances;
  }
}

// Déploiement d'une instance (T4-28b1) : la route n'existe que si l'appelant la fournit, réservée à l'équipe, 503 tant que `ouvert` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeDeploiementInstances(appli, { ouvert: false, authentifier: GARDE_VIDE, creer: VIDE, tester: VIDE, activer: VIDE, mettreAJour: VIDE }),
  serveur: surCle("deploiementInstances", routeDeploiementInstances),
};

export default branchement;
