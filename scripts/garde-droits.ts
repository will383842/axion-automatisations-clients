import { ACTIONS } from "../apps/api/src/droits/matrice.js";
import type { RouteListee } from "./liste-routes.js";

// Garde des droits (T3-06) : toute route de la console déclare son action dans la matrice (apps/api/src/droits/par-route/<module>.ts, fusionnés par actions-par-route.ts). Même méthode que la garde « mauvais client » (C-536).
// Limite connue (règle 9.4) : la garde voit la déclaration, pas la pose du crochet exigerDroit sur chaque route (dette portée par la fiche de câblage des routes de l'équipe).
export const EXEMPTEES_DROITS: Readonly<Record<string, string>> = {
  "POST /api/console/v1/entree": "Entrée C6 : jeton signé dans le corps, aucune session d'équipe encore ; réponse toujours la même adresse de connexion.",
};
const CONSOLE = /^(\/api\/console\/v1\/|\/equipe\/)/;

export const routesDeLaConsole = (routes: RouteListee[]): string[] =>
  routes.filter((r) => CONSOLE.test(r.chemin)).map((r) => `${r.methode} ${r.chemin}`);

export function routesSansAction(routes: string[], registre: Readonly<Record<string, string>>): string[] {
  return routes.filter((r) => !Object.hasOwn(registre, r) && !Object.hasOwn(EXEMPTEES_DROITS, r)).map((r) => `${r} : aucune action déclarée dans la matrice`);
}

export function actionsInvalides(registre: Readonly<Record<string, string>>, routesExistantes: string[]): string[] {
  const existantes = new Set(routesExistantes);
  return Object.entries(registre).flatMap(([route, action]) => [
    ...((ACTIONS as readonly string[]).includes(action) ? [] : [`${route} : action « ${action} » hors de la liste fermée`]),
    ...(existantes.has(route) ? [] : [`${route} : route déclarée mais absente de l'API`]),
  ]);
}
