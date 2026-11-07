import { routeClients, type DepsClients } from "../clients/liste.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    clients: DepsClients;
  }
}

// Espace Clients (T3-10) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeClients(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, membre: VIDE, clients: VIDE, vues: VIDE, tracerExport: VIDE }),
  serveur: surCle("clients", routeClients),
};

export default branchement;
