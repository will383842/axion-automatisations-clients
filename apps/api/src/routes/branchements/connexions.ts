import { routeLiensConnexions } from "../connexions/liens.js";
import { routeRevocationConnexion } from "../connexions/revocation.js";
import { VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

// Listée seulement : le serveur ne la branche pas (fermée par défaut, porte par outil).
const branchement: Branchement = {
  lister: (appli) => {
    routeLiensConnexions(appli, { exigerEquipe: GARDE_VIDE, session: VIDE, porte: () => false, nouvelId: VIDE, creer: VIDE, ecrireCoffre: VIDE, emettreLien: VIDE });
    routeRevocationConnexion(appli, { exigerEquipe: GARDE_VIDE, session: VIDE, revoquer: VIDE });
  },
};

export default branchement;
