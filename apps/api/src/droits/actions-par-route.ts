import { readdirSync } from "node:fs";
import { ACTIONS, type Action } from "./matrice.js";

// Action de chaque route de la console (garde scripts/garde-droits.ts). Le dossier par-route/ est lu à l'exécution, trié par nom : un fichier par module de routes (même nom que son fichier de branchement).
// Un fichier hors forme, une action hors liste fermée ou une route en double fait ÉCHOUER le chargement, jamais ignoré (ADR 0139). Les fragments n'importent que le TYPE depuis matrice.ts.
const NOM = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:ts|js)$/;
const CLE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//;
const estObjetSimple = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const estAction = (v: unknown): v is Action => typeof v === "string" && (ACTIONS as readonly string[]).includes(v);

export function fusionnerActions(entrees: { nom: string; module: unknown }[]): Readonly<Record<string, Action>> {
  const origine = new Map<string, string>();
  const fusion: Record<string, Action> = {};
  for (const { nom, module } of [...entrees].sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0))) {
    if (!NOM.test(nom)) throw new Error(`fragment de droits refusé : nom « ${nom} » hors forme`);
    const frag = typeof module === "object" && module !== null ? (module as Record<string, unknown>)["default"] : undefined;
    if (!estObjetSimple(frag)) throw new Error(`fragment ${nom} : l'export par défaut n'est pas un objet simple`);
    for (const [route, action] of Object.entries(frag)) {
      if (!CLE.test(route)) throw new Error(`fragment ${nom} : clé « ${route} » hors forme (méthode, espace, chemin commençant par /)`);
      if (!estAction(action)) throw new Error(`fragment ${nom} : ${route} : action « ${String(action)} » hors de la liste fermée`);
      const autre = origine.get(route);
      if (autre) throw new Error(`route « ${route} » déclarée dans deux fichiers : ${autre} et ${nom}`);
      origine.set(route, nom);
      fusion[route] = action;
    }
  }
  const trie: Record<string, Action> = {};
  for (const cle of Object.keys(fusion).sort()) trie[cle] = fusion[cle]!;
  return Object.freeze(trie);
}

const DOSSIER = new URL("./par-route/", import.meta.url);
export const ACTION_PAR_ROUTE = fusionnerActions(
  await Promise.all(readdirSync(DOSSIER).sort().map(async (nom) => ({ nom, module: NOM.test(nom) ? await import(new URL(nom, DOSSIER).href) : undefined }))),
);
