import { ACTIONS_COMPTABILITE, type ConnecteurComptabilite } from "../familles/comptabilite.ts";
import { creerSuite, verifier } from "./agenda.ts";

const facture = (cle: string) => ({ cle, fournisseur: "Atelier Bertin", montantCentimes: 1200 });

export const { CAS, fabriqueMemoire, jouerSuite } = creerSuite<ConnecteurComptabilite>({
  famille: "comptabilite",
  actions: ACTIONS_COMPTABILITE,
  garanties: { creer_facture_fournisseur_brouillon: "idempotent_par_cle" },
  methodes: ["creerFactureFournisseur"],
  connecteur: (a) => ({
    creerFactureFournisseur: (j, f) => a.proteger(j, () => ({ id: a.ecrire(f.cle, "brouillon"), statut: "brouillon" as const })),
  }),
  nominal: (c, j) => c.creerFactureFournisseur(j, facture("cle-0")),
  ecriture: (c, j) => c.creerFactureFournisseur(j, facture("cle-1")),
  extra: [
    {
      nom: "jamais de document définitif",
      scenario: { nom: "nominal" },
      jouer: async (b) => verifier((await b.connecteur.creerFactureFournisseur(b.jeton, facture("cle-2"))).statut === "brouillon", "brouillon attendu"),
    },
  ],
});
