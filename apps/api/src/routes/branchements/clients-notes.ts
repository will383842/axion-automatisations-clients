import { routeNotes, type DepsNotes } from "../clients/notes.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    notes: DepsNotes;
  }
}

// Notes d'un client (T3-13) : les routes n'existent que si l'appelant les fournit, et répondent 503 tant que `ouvert()` est faux (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeNotes(appli, { ouvert: () => false, exigerEquipe: GARDE_VIDE, session: VIDE, lister: VIDE, ajouter: VIDE, epingler: VIDE, noterAppelEtClore: VIDE }),
  serveur: surCle("notes", routeNotes),
};

export default branchement;
