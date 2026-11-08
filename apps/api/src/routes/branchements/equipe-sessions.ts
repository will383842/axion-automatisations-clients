import { routeSessions, type DepsRoutesSessions } from "../equipe/sessions.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    sessionsEquipe: DepsRoutesSessions;
  }
}

// Sécurité de l'équipe, sessions (T3-07b) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert` est faux (SECURITE_EQUIPE_OUVERTE, fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeSessions(appli, { ouvert: false, exigerJeton: GARDE_VIDE, exigerReauthentification: GARDE_VIDE, droits: VIDE, sessions: VIDE, acces: VIDE }),
  serveur: surCle("sessionsEquipe", routeSessions),
};

export default branchement;
