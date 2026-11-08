import { routeJournaux, type DepsJournaux } from "../../supervision/journaux/routes.js";
import { surCle, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    journaux: DepsJournaux;
  }
}

// Lecture des journaux regroupés (A-080) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert()` est faux.
const branchement: Branchement = {
  lister: (appli) => routeJournaux(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, exigerReauthentification: GARDE_VIDE, lecture: { url: "" } }),
  serveur: surCle("journaux", routeJournaux),
};

export default branchement;
