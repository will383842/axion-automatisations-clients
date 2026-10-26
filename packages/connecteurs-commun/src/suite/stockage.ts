import { ACTIONS_STOCKAGE, type ConnecteurStockage } from "../familles/stockage.ts";
import { creerSuite } from "./agenda.ts";

export const { CAS, fabriqueMemoire, jouerSuite } = creerSuite<ConnecteurStockage>({
  famille: "stockage",
  actions: ACTIONS_STOCKAGE,
  garanties: { lister: "au_plus_une_fois", lire: "au_plus_une_fois", deposer: "idempotent_par_cle" },
  methodes: ["lister", "lire", "deposer"],
  connecteur: (a) => ({
    lister: (j) => a.proteger(j, () => ["essai.txt"]),
    lire: (j, chemin) => a.proteger(j, () => ({ nom: chemin, contenu: "Texte" })),
    deposer: (j, d) => a.proteger(j, () => ({ id: a.ecrire(d.cle, "doc") })),
  }),
  nominal: (c, j) => c.lire(j, "essai.txt"),
  ecriture: (c, j) => c.deposer(j, { cle: "cle-1", dossier: "essais", nom: "essai.txt", contenu: "Texte" }),
});
