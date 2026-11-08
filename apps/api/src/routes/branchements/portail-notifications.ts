import { routeNotificationsPortail, type DepsRouteNotifications } from "../portail/notifications.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    notificationsPortail: DepsRouteNotifications;
  }
}

// Préférences de notification du portail (T6-24c) : branchées seulement si l'appelant fournit la session et le dépôt ; absent, les routes n'existent pas.
const branchement: Branchement = {
  lister: (appli) => routeNotificationsPortail(appli, VIDE),
  serveur: surCle("notificationsPortail", routeNotificationsPortail),
};

export default branchement;
