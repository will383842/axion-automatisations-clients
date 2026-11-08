import { routeFileAlertes, type DepsFileAlertes } from "../../supervision/alertes/routes.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    fileAlertes: DepsFileAlertes;
  }
}

// File d'alertes de l'équipe (T5-04c) : les routes n'existent que si l'appelant fournit `fileAlertes`, et répondent 503 tant que `ouvert` (SUPERVISION_ALERTES_OUVERTE) est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeFileAlertes(appli, { ouvert: false, authentifier: GARDE_VIDE, droits: VIDE, lire: VIDE, cycle: VIDE, regles: VIDE }),
  serveur: surCle("fileAlertes", routeFileAlertes),
};

export default branchement;
