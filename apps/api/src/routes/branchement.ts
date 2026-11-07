import type { FastifyInstance } from "fastify";

// Registre des branchements de routes (ADR 0139) : une route s'inscrit par un fichier NEUF dans routes/branchements/, jamais par une ligne dans un fichier commun.
// Chaque fichier ajoute sa clé et ses dépendances à cette interface par `declare module` ; le typage des options de construireServeur en découle.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentée par chaque fichier de routes/branchements (declare module)
export interface OptionsBranchements {}

export type Branchement = {
  // Liste des routes (scripts/liste-routes.ts) : dépendances vides, sans listen.
  readonly lister: (appli: FastifyInstance) => void;
  // Serveur réel : absent = le module n'est pas branché par construireServeur ; `toujours` = branché d'office (santé) ; `cle` = fermé par défaut, branché seulement si l'appelant fournit la clé.
  readonly serveur?: { readonly toujours: true; readonly brancher: (s: FastifyInstance) => void } | { readonly cle: keyof OptionsBranchements; readonly brancher: (s: FastifyInstance, deps: unknown) => void };
};

export function surCle<K extends keyof OptionsBranchements>(cle: K, brancher: (s: FastifyInstance, d: OptionsBranchements[K]) => void) {
  return { cle, brancher: (s: FastifyInstance, d: unknown) => brancher(s, d as OptionsBranchements[K]) };
}

// Dépendances vides des listes de routes et des essais : aucune n'est appelée.
export const VIDE = {} as never;
export const GARDE_VIDE = (async () => undefined) as never;
