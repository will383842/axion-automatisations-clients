// Contexte d'une étape (C4 v0.2.0) : réglages de l'instance, effets sur les connecteurs déclarés,
// passerelle d'IA, motif. Rien d'autre : aucune lecture d'un autre fil, d'une autre instance ni d'un autre client.
export const CLES_CONTEXTE = ["reglages", "signal", "effet", "ia", "noterMotif"] as const;

// Passerelle d'IA de l'instance : le modèle est choisi parmi `ia.modelesAdmis` du manifeste ; jetons et coût remontent dans l'événement fin.
export interface PasserelleIa {
  completer(demande: { modele: string; entree: string }): Promise<{ texte: string; jetons: number; coutIaMicroCentimes: number }>;
}

// Port de données (C4 0.4.0) : seules les requêtes et actions déclarées par le module (`donnees` du manifeste) répondent ;
// un autre nom est refusé. Aucune autre ouverture vers une base ; le SQL et l'historique restent du côté du port.
export interface PortDonnees {
  lire(nom: string, parametres?: Readonly<Record<string, unknown>>): Promise<readonly Record<string, unknown>[]>;
  ecrire(nom: string, parametres?: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface ContexteEtape {
  readonly reglages: Readonly<Record<string, unknown>>;
  // Le délai coupe l'attente, pas l'effet en vol : `appeler` finit dans la marge après l'arrêt (ADR 0018).
  readonly signal: AbortSignal;
  // Effet externe garanti : intention écrite avant, garantie du connecteur après une coupure.
  effet(action: string, element: string, entree?: unknown): Promise<void>;
  readonly ia: PasserelleIa;
  // Motif de l'IA pour la file de validation (C-561) : texte court, jamais écrit dans le journal.
  noterMotif(texte: string): void;
  // Facultatif, et hors de CLES_CONTEXTE, tant que l'exécuteur ne le fournit pas (T4-50) ; absent = le module n'a rien déclaré.
  readonly donnees?: PortDonnees;
}
