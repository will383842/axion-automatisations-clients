// Liste unique des sous-traitants ultérieurs (C-032, A-112). Le contrat, le centre de conformité et « Mes documents » la lisent ICI :
// aucune des trois copies n'est écrite à la main. Les accords de traitement sont signés par Will (porte F), jamais par la routine.
export type AccordTraitement = "signe" | "a_signer";

export interface SousTraitant {
  id: string;
  nom: string;
  service: string;
  role: string;
  lieu: string;
  accord: AccordTraitement;
}

export const LISTE_SOUS_TRAITANTS: readonly SousTraitant[] = [
  { id: "st-hebergeur", nom: "Hébergeur", service: "hébergement des serveurs", role: "hébergement des données", lieu: "UE", accord: "a_signer" },
  { id: "st-ia", nom: "Fournisseurs d'IA", service: "passerelle d'IA", role: "traitement des requêtes d'IA", lieu: "à vérifier", accord: "a_signer" },
  { id: "st-cloudflare", nom: "Cloudflare", service: "relais réseau", role: "relais chiffré, rien de stocké", lieu: "à vérifier", accord: "a_signer" },
  { id: "st-sentry", nom: "Sentry", service: "suivi des erreurs", role: "suivi des erreurs techniques", lieu: "à vérifier", accord: "a_signer" },
  { id: "st-messagerie", nom: "Messagerie de service", service: "e-mails de service", role: "envoi des e-mails de service", lieu: "UE", accord: "a_signer" },
  {
    id: "st-stripe",
    nom: "Stripe",
    service: "paiements",
    role: "encaissement des paiements (carte, prélèvement SEPA, lien de paiement) ; encaissement, aucune facture",
    lieu: "UE, à vérifier",
    accord: "a_signer",
  },
];

const copie = (): SousTraitant[] => LISTE_SOUS_TRAITANTS.map((l) => ({ ...l }));

export const listeContrat = copie;
export const listeCentreConformite = copie;
export const listeMesDocuments = copie;
