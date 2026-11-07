// Registre des écrans de la console (T3-04). Chaque page sous src/app/ a UNE ligne ici, sinon la garde (scripts/garde-ecrans.ts) échoue.
// Une fiche d'écran inscrit son écran : le banc (src/etats/) le passe alors dans tous ses états déclarés.
export type Etat = "normal" | "vide" | "chargement" | "erreur" | "session-expiree" | "acces-refuse" | "hors-ligne";

export interface Parcours {
  nom: string;
  /** Clics depuis l'accueil pour une tâche courante : trois au plus (B-202). */
  clics: number;
}

export interface Ecran {
  /** Adresse de l'écran, groupes de dossiers retirés. */
  route: string;
  /** Page, relative à src/app/. */
  page: string;
  /** Maquette approuvée suivie par l'écran ; null tant que l'écran est vide (coquille). */
  maquette: string | null;
  /**
   * États recettés. Un état autre que « normal » est fourni par la page : export nommé `etats` = { vide: Composant, … }.
   * Liste vide : page de passage, sans contenu à recetter.
   */
  etats: readonly Etat[];
  parcours?: readonly Parcours[];
}

const coquille = (nom: string): Ecran => ({ route: `/${nom}`, page: `(equipe)/${nom}/page.tsx`, maquette: null, etats: ["normal"] });

export const ECRANS: readonly Ecran[] = [
  { route: "/", page: "page.tsx", maquette: null, etats: [] },
  { route: "/entree", page: "entree/page.tsx", maquette: null, etats: [] },
  { route: "/connexion/reconnexion", page: "connexion/reconnexion/page.tsx", maquette: null, etats: ["normal"], parcours: [{ nom: "se reconnecter", clics: 1 }] },
  // Fiche client (T3-13) : pages de passage tant que l'appel à l'API de la fiche n'est pas câblé ; le bandeau et le résumé sont recettés par leurs tests.
  { route: "/clients/[id]", page: "(equipe)/clients/[id]/page.tsx", maquette: "F-Console-Fiche", etats: [] },
  { route: "/clients/[id]/notes", page: "(equipe)/clients/[id]/notes/page.tsx", maquette: "F-Console-Fiche", etats: [] },
  ...["accueil", "clients", "alertes", "demandes", "facturation", "catalogue", "conformite", "securite", "plus"].map(coquille),
];
