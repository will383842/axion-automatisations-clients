// Cycle de vie d'une version (T4-27b, ADR 0122) : règles pures, sans base ni horloge. Le graphe recopie celui de catalogue_garde (0007) pour refuser tôt, avec un message clair.
export const STATUTS = ["brouillon", "recette", "pilote", "publiee", "depreciee", "retiree"] as const;
export type Statut = (typeof STATUTS)[number];

export const PASSAGES_PERMIS: readonly (readonly [Statut, Statut])[] = [
  ["brouillon", "recette"],
  ["recette", "brouillon"],
  ["recette", "pilote"],
  ["pilote", "publiee"],
  ["publiee", "depreciee"],
  ["depreciee", "retiree"],
];
export const passagePermis = (depart: Statut, arrivee: Statut): boolean => PASSAGES_PERMIS.some(([d, a]) => d === depart && a === arrivee);

export const DELAI_PILOTE_JOURS = 7;
// Étape 6 (C-246) : la case existe, le gardien ne la coche qu'au lot 8b ; l'interrupteur procedure.etape6Exigee est fermé par défaut.
export interface Interrupteurs { etape6Exigee: boolean }

// Étapes dont une preuve est exigée pour ENTRER dans un état (plan T4-27, section 2.2). Les étapes 9 (calculée) et 10 (rangée au passage) sont traitées par la machine.
export function etapesRequises(arrivee: Statut, i: Interrupteurs): number[] {
  if (arrivee === "recette") return [1, 2, 3, 5, 8];
  if (arrivee === "pilote") return i.etape6Exigee ? [4, 6, 7] : [4, 7];
  return [];
}

// Ce que chaque état permet (A-031, B-460, B-461, A-307). `estPiloteInterne` : le pilote interne est le seul client qui reçoit une version « pilote ».
export const versionVendable = (statut: Statut): boolean => statut === "publiee";
export const versionDeployable = (statut: Statut, estPiloteInterne: boolean): boolean => statut === "publiee" || (statut === "pilote" && estPiloteInterne);
// « Retirée » arrête des exécutions, jamais des données : une instance pas encore migrée vers la remplaçante continue.
export const peutContinuerExecution = (statut: Statut, instanceMigree: boolean): boolean =>
  statut === "pilote" || statut === "publiee" || statut === "depreciee" || (statut === "retiree" && !instanceMigree);
