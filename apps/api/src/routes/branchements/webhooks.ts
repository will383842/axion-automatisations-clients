import { routeWebhooks, type DepsWebhooks } from "../webhooks/entree.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    webhooks: DepsWebhooks;
  }
}

// Webhooks entrants (T4-24) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `actif()` est faux (WEBHOOKS_OUVERTS, fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeWebhooks(appli, { actif: () => false, depot: VIDE, secret: VIDE, instance: VIDE, memoire: VIDE, file: VIDE, sceller: VIDE, debit: { parWebhook: 1, global: 1, fenetreMs: 1 } }),
  serveur: surCle("webhooks", routeWebhooks),
};

export default branchement;
