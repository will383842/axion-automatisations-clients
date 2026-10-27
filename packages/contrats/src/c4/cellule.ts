import { STATUT_PAR_CODE } from "../commun/erreurs.ts";
import type { RouteContrat } from "../commun/routes.ts";
import type { Paquet } from "./evenements-executeur.ts";

// Routes de l'exécuteur vers la console, signées par la clé de la cellule.
export const ROUTES_C4 = {
  configuration: { methode: "GET", chemin: "/api/executeur/v1/instances/{instanceId}/configuration", limite: "c4", antiDoublon: "lecture" },
  etatVoulu: { methode: "GET", chemin: "/api/executeur/v1/instances/{instanceId}/etat-voulu", limite: "c4", antiDoublon: "lecture" },
  evenements: { methode: "POST", chemin: "/api/executeur/v1/evenements", limite: "c4", antiDoublon: "execution" },
} as const satisfies Record<string, RouteContrat>;

// Clé d'une cellule (X-Axion-Cle) : `c4:<celluleId>:<kid>` ; `kid` distingue les 2 clés d'une rotation.
// Une seule forme, celle du coffre (apps/api/src/coffre/cles-echanges.ts, ADR 0033) : minuscules, chiffres, tirets.
// Correspondance : X-Axion-Cle `c4:<cellule>:<kid>` ↔ secret rangé sous technique/echanges/c4-<cellule>/<kid>.
const MOT = "[a-z0-9]+(?:-[a-z0-9]+)*";
const CLE_C4 = new RegExp(`^c4:(?=[^:]{1,64}:)(${MOT}):(?=[^:]{1,32}$)(${MOT})$`);
export const celluleDeLaCle = (cle: string): string | null => CLE_C4.exec(cle)?.[1] ?? null;
export function emplacementCoffre(cle: string): { canal: string; kid: string } | null {
  const m = CLE_C4.exec(cle);
  return m ? { canal: `c4-${m[1]}`, kid: m[2] as string } : null;
}

export type VerdictCellule = { ok: true } | { ok: false; code: "action_interdite"; statut: typeof STATUT_PAR_CODE.action_interdite };
const interdit: VerdictCellule = { ok: false, code: "action_interdite", statut: STATUT_PAR_CODE.action_interdite };

// RÈGLE (T0-30, cellules partagées par plusieurs clients) : la console ne sert une instance qu'à la cellule qui l'exécute.
// `cle` : identifiant rendu par verifier() ; `celluleDeLInstance` : lu par la console dans SES données, jamais dans la requête.
// Lecture de configuration ou d'état voulu d'une instance d'une autre cellule : 403 action_interdite.
export function controlerLecture(cle: string, instanceId: string, celluleDeLInstance: (instanceId: string) => string | null): VerdictCellule {
  const cellule = celluleDeLaCle(cle);
  return cellule !== null && celluleDeLInstance(instanceId) === cellule ? { ok: true } : interdit;
}

// Paquet : chaque événement doit viser une instance de la cellule qui signe, et un signal de vie doit nommer
// cette cellule. Un seul écart et le paquet ENTIER est refusé (403 action_interdite), rien n'est compté.
export function controlerPaquet(cle: string, paquet: Paquet, celluleDeLInstance: (instanceId: string) => string | null): VerdictCellule {
  const cellule = celluleDeLaCle(cle);
  if (cellule === null) return interdit;
  for (const e of paquet.evenements) {
    if (celluleDeLInstance(e.instanceId) !== cellule) return interdit;
    if (e.type === "signal_de_vie" && e.celluleId !== cellule) return interdit;
  }
  return { ok: true };
}
