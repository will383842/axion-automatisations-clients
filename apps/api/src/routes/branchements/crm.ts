import { routeCrm, type DepsCrm } from "../crm.js";
import { surCle, VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    crm: DepsCrm;
  }
}

// Récepteur C3 : branché seulement si le dépôt, la file et l'entrant sont fournis ; la porte du canal reste fermée par défaut (503).
// Le démarrage réel (Valkey, travailleur) reste la dette LOT2-dette-T2-14-cablage (propriétaire T2-21).
const branchement: Branchement = {
  lister: (appli) => {
    const entrant = { cles: VIDE, memoire: VIDE, actif: () => false };
    routeCrm(appli, { entrant, recepteur: VIDE, file: VIDE });
  },
  serveur: surCle("crm", routeCrm),
};

export default branchement;
