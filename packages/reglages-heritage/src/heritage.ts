// Héritage des valeurs (B-515, A-160) : UNE fonction pure, sans base, partagée par l'API (commercial, T2-08) et par les réglages des modules (T4-30).
// Niveaux, du plus général au plus précis : plateforme (global) → automatisation (défauts du modèle) → secteur (métier, préréglage) → client → instance.
// Cette liste est unique : la même dans B-515, T4-30 et T8B-11. Ne jamais en écrire une autre.
// Règles :
// - la valeur du niveau le plus précis qui en a une l'emporte ; une valeur absente passe au niveau suivant ;
// - `valeur: null` posé à un niveau est une VALEUR (« aucune remise »), différente d'absente ;
// - `imposee: true` fige la valeur : aucun niveau plus précis ne la change (la lecture l'ignore, l'écriture est refusée par verifierEcriture) ;
// - le résultat ne dépend pas de l'ordre des clés de l'entrée : les niveaux sont parcourus dans l'ordre de NIVEAUX ;
// - les valeurs sont rendues telles quelles (même référence), jamais copiées : un niveau client partagé par plusieurs modules est lu, pas recopié.
export const NIVEAUX = ["global", "automatisation", "metier", "client", "instance"] as const;
export type Niveau = (typeof NIVEAUX)[number];

export type ValeurNiveau = {
  valeur: unknown;
  // Version du niveau qui a fourni la valeur (pour retrouver ce qui a été appliqué).
  version?: number;
  imposee?: boolean;
  // Sous-origine libre à l'intérieur d'un niveau (ex. « grille » ou « defaut » au niveau global) ; ignorée par le calcul.
  origine?: string;
};
export type NiveauxConnus = Partial<Record<Niveau, Record<string, ValeurNiveau | undefined>>>;
export type Resolu = { valeur: unknown; source: Niveau; version: number | undefined; imposee: boolean; origine: string | undefined };

export class ErreurHeritage extends Error {
  constructor(readonly motif: string) {
    super(motif);
  }
}

function controler(niveaux: NiveauxConnus): void {
  for (const nom of Object.keys(niveaux)) if (!(NIVEAUX as readonly string[]).includes(nom)) throw new ErreurHeritage(`niveau_inconnu:${nom}`);
}
// Own seulement : « toString » ou « __proto__ » ne sont jamais une valeur.
const lire = (niveaux: NiveauxConnus, niveau: Niveau, cle: string): ValeurNiveau | undefined => {
  const du = Object.hasOwn(niveaux, niveau) ? niveaux[niveau] : undefined;
  return du && Object.hasOwn(du, cle) ? du[cle] : undefined;
};

export function resoudre(cle: string, niveaux: NiveauxConnus): Resolu | null {
  controler(niveaux);
  let retenu: Resolu | null = null;
  for (const niveau of NIVEAUX) {
    const v = lire(niveaux, niveau, cle);
    if (!v) continue;
    retenu = { valeur: v.valeur, source: niveau, version: v.version, imposee: v.imposee === true, origine: v.origine };
    if (retenu.imposee) break;
  }
  return retenu;
}

// À appeler avant d'écrire une valeur à `niveau` : refuse si un niveau plus général l'a imposée.
export function verifierEcriture(cle: string, niveau: Niveau, niveaux: NiveauxConnus): void {
  controler(niveaux);
  const rang = NIVEAUX.indexOf(niveau);
  for (const general of NIVEAUX.slice(0, rang)) {
    if (lire(niveaux, general, cle)?.imposee === true) throw new ErreurHeritage(`valeur_imposee:${cle}:${general}`);
  }
}
