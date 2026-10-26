import { ACTIONS_MESSAGERIE_EQUIPE, type ConnecteurMessagerieEquipe } from "../familles/messagerie-equipe.ts";
import { creerSuite } from "./agenda.ts";

export const { CAS, fabriqueMemoire, jouerSuite } = creerSuite<ConnecteurMessagerieEquipe>({
  famille: "messagerie-equipe",
  actions: ACTIONS_MESSAGERIE_EQUIPE,
  garanties: { publier: "idempotent_par_cle" },
  methodes: ["publier"],
  connecteur: (a) => ({
    publier: (j, m) => a.proteger(j, () => ({ id: a.ecrire(m.cle, "msg") })),
  }),
  nominal: (c, j) => c.publier(j, { cle: "cle-0", canal: "general", texte: "Bonjour" }),
  ecriture: (c, j) => c.publier(j, { cle: "cle-1", canal: "general", texte: "Bonjour" }),
});
