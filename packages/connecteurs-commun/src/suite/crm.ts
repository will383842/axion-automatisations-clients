import { ACTIONS_CRM, type ConnecteurCrm } from "../familles/crm.ts";
import { creerSuite } from "./agenda.ts";

export const { CAS, fabriqueMemoire, jouerSuite } = creerSuite<ConnecteurCrm>({
  famille: "crm",
  actions: ACTIONS_CRM,
  garanties: { chercher_contact: "au_plus_une_fois", ajouter_contact: "idempotent_par_cle" },
  methodes: ["chercherContact", "ajouterContact"],
  connecteur: (a) => ({
    chercherContact: (j, email) => a.proteger(j, () => (a.ecrits.size ? { id: "ctc-1", email } : null)),
    ajouterContact: (j, c) => a.proteger(j, () => ({ id: a.ecrire(c.cle, "ctc") })),
  }),
  nominal: (c, j) => c.ajouterContact(j, { cle: "cle-0", email: "alice@exemple.fr", nom: "Alice" }),
  ecriture: (c, j) => c.ajouterContact(j, { cle: "cle-1", email: "alice@exemple.fr", nom: "Alice" }),
});
