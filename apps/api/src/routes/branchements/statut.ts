import { routeStatut, type DepsStatut } from "../../supervision/statut/routes.js";
import { routeSonde, type DepsSonde } from "../../supervision/statut/sonde.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    pageEtat: { statut: DepsStatut; sonde: DepsSonde };
  }
}

// Page d'état publique, gestion par l'équipe et signal de la sonde extérieure (T5-12b) : les quatre routes n'existent que si l'appelant fournit `pageEtat`,
// et répondent 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => {
    routeStatut(appli, { ouvert: () => false, droits: VIDE, etatsBriques: VIDE, incidents: VIDE, depot: VIDE, maintenant: Date.now });
    routeSonde(appli, { ouvert: () => false, cles: VIDE, ouvrirIncident: VIDE, maintenant: Date.now });
  },
  serveur: surCle("pageEtat", (s, d) => {
    routeStatut(s, d.statut);
    routeSonde(s, d.sonde);
  }),
};

export default branchement;
