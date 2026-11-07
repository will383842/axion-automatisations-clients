// Registre des onglets de la fiche client (T3-13). Un onglet non livré n'apparaît pas : la fiche suivante passe `livre` à vrai en même temps qu'elle ajoute sa page.
export interface OngletFiche {
  cle: string;
  libelle: string;
  /** Segment d'adresse sous /clients/<id>/ ; vide pour le Résumé. */
  segment: string;
  livre: boolean;
}

export const ONGLETS_FICHE: readonly OngletFiche[] = [
  { cle: "resume", libelle: "Résumé", segment: "", livre: true },
  { cle: "contrat", libelle: "Contrat et plan", segment: "contrat", livre: false },
  { cle: "automatisations", libelle: "Automatisations", segment: "automatisations", livre: false },
  { cle: "reglages", libelle: "Réglages", segment: "reglages", livre: false },
  { cle: "outils", libelle: "Outils et connexions", segment: "outils", livre: false },
  { cle: "ia", libelle: "IA, coût et marge", segment: "ia", livre: false },
  { cle: "sante", libelle: "Santé et exécutions", segment: "sante", livre: false },
  { cle: "donnees", libelle: "Données et quotas", segment: "donnees", livre: false },
  { cle: "demandes", libelle: "Demandes", segment: "demandes", livre: false },
  { cle: "utilisateurs", libelle: "Utilisateurs du client", segment: "utilisateurs", livre: false },
  { cle: "notes", libelle: "Notes", segment: "notes", livre: true },
  { cle: "journal", libelle: "Journal", segment: "journal", livre: false },
  { cle: "conformite", libelle: "Conformité", segment: "conformite", livre: false },
  { cle: "visibilite", libelle: "Visibilité et accès", segment: "visibilite", livre: false },
  // Factures : lot 7.
  { cle: "factures", libelle: "Factures", segment: "factures", livre: false },
];
export const ongletsLivres = (): OngletFiche[] => ONGLETS_FICHE.filter((o) => o.livre);

// Forme de la réponse de GET /api/console/v1/clients/:id/fiche.
export type EtatClient = "ok" | "a_aider" | "urgent" | "pause";
export interface FicheClient {
  bandeau: {
    nom: string;
    etat: EtatClient;
    formule: string;
    derniere_erreur: { code: string; message: string } | null;
    connexions: { total: number; a_reprendre: number };
    prochaine_echeance: string | null;
  };
  resume: {
    abonnement: { formule: string; engagement: string | null };
    automatisations_actives: number;
    reglages: { versions: number };
    connexions: { total: number; a_reprendre: number };
    executions: { reussies_pourcent: number | null; en_attente: number };
    notes: { total: number; epinglees: number };
    factures: { en_attente: number };
  };
}

// Lecture de la fiche par la console. Tant que l'appel à l'API n'est pas câblé (dette portée au compte rendu), la fiche est « indisponible » (rend null) : aucune donnée inventée.
// « absente » : l'API a répondu 404 (client hors portée ou inconnu) ; la page répond 404 aussi.
export async function lireFiche(id: string | undefined): Promise<FicheClient | "absente" | null> {
  return id === undefined ? null : null;
}
