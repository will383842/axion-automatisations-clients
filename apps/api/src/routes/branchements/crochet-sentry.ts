import { routeCrochetSentry, type DepsCrochetSentry } from "../../supervision/journaux/crochet-sentry.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    crochetSentry: DepsCrochetSentry;
  }
}

// Crochet Sentry (C-387) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert()` est faux.
const branchement: Branchement = {
  lister: (appli) => routeCrochetSentry(appli, { ouvert: () => false, secret: () => undefined, taches: VIDE }),
  serveur: surCle("crochetSentry", routeCrochetSentry),
};

export default branchement;
