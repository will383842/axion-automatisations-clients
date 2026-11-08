import { routeRecherche, type DepsRecherche } from "../recherche.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    recherche: DepsRecherche;
  }
}

// Recherche globale (T3-09a) : la route n'existe que si l'appelant la fournit, réservée à l'équipe, 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeRecherche(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, membre: VIDE, depot: VIDE, debit: { parMembre: 1, fenetreMs: 1 } }),
  serveur: surCle("recherche", routeRecherche),
};

export default branchement;
