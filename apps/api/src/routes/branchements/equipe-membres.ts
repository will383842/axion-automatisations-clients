import { routeMembres, type DepsRoutesMembres } from "../equipe/membres.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    membresEquipe: DepsRoutesMembres;
  }
}

// Membres de l'équipe (T3-07c) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert` est faux (SECURITE_EQUIPE_OUVERTE, fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeMembres(appli, { ouvert: false, exigerJeton: GARDE_VIDE, exigerReauthentification: GARDE_VIDE, droits: VIDE, service: VIDE }),
  serveur: surCle("membresEquipe", routeMembres),
};

export default branchement;
