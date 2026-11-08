import { routeVueClient, type DepsVueClient } from "../equipe/vue-client.js";
import { brancherGardeLectureSeule } from "../../vue-client/garde-lecture-seule.js";
import { surCle, VIDE, GARDE_VIDE, type Branchement } from "../branchement.js";

declare module "../branchement.js" {
  interface OptionsBranchements {
    vueClient: DepsVueClient;
  }
}

// Vue « comme le client » (T3-08a) : la garde de lecture seule (crochet racine) et les routes ne sont branchées que si l'appelant fournit `vueClient` (fermé par défaut).
const branchement: Branchement = {
  lister: (appli) => routeVueClient(appli, { garde: VIDE, exigerDroit: GARDE_VIDE, equipe: VIDE, vue: VIDE, maintenant: VIDE, envois: VIDE, trace: VIDE }),
  serveur: surCle("vueClient", (s, d) => { brancherGardeLectureSeule(s, d.garde); routeVueClient(s, d); }),
};

export default branchement;
