import { estPhaseContracter } from "../../../../scripts/garde-migrations.ts";

// Règles bloquantes des versions de structure (T2-38) : fonctions pures, sans base ni horloge. Le service des vagues et migrerBase les appellent ; le texte des refus ne cite aucun client.
// « Étendre puis contracter » : une migration ne fait qu'ajouter ; seule une migration marquée `-- phase: contracter` peut supprimer, et seulement quand tout le parc est en N et le code en N+1.
export { estPhaseContracter };
export type Decision = { permis: true } | { permis: false; raison: string };
const refus = (raison: string): Decision => ({ permis: false, raison });

export interface EtatContracter {
  // CONTRACTER_OUVERT (config.ts) : fermé tant que Will ne l'a pas ouvert (lot 8a).
  interrupteurOuvert: boolean;
  // N : version atteinte par toutes les bases avant la migration « contracter ».
  versionN: number;
  // Version de structure de CHAQUE base du registre (quarantaine comprise : une base restée en N-1 y est lue en N-1).
  versionsDesBases: readonly number[];
  // Version de structure du code déployé, lue dans la configuration ; absente = inconnue = refus.
  versionCodeDeployee: number | undefined;
}

export function contracterPermis(e: EtatContracter): Decision {
  if (e.interrupteurOuvert !== true) return refus("contracter est fermé : l'interrupteur CONTRACTER_OUVERT n'est pas ouvert");
  if (e.versionsDesBases.length === 0) return refus("contracter refusé : aucune base connue au registre");
  if (e.versionsDesBases.some((v) => !Number.isInteger(v) || v < e.versionN)) return refus(`contracter refusé : toutes les bases ne sont pas en version ${e.versionN}`);
  if (e.versionCodeDeployee === undefined || !Number.isInteger(e.versionCodeDeployee) || e.versionCodeDeployee < e.versionN + 1) return refus(`contracter refusé : le code déployé n'est pas en version ${e.versionN + 1}`);
  return { permis: true };
}

// Viser la version N+1 alors qu'une base reste en N-1 (c'est-à-dire en retard de deux versions sur la cible) est refusé : le code accepte N et N-1, pas N-2.
export function migrationSuivantePermise(e: { versionCible: number; versionsDesBases: readonly number[] }): Decision {
  if (e.versionsDesBases.some((v) => !Number.isInteger(v) || v < e.versionCible - 1)) return refus(`version ${e.versionCible} refusée : une base reste en N-1 (version ${e.versionCible - 2} ou moins)`);
  return { permis: true };
}

// Aucune migration descendante en production : le retour arrière est celui du code seulement.
export function verifierDescente(versionActuelle: number, versionCible: number, production: boolean): void {
  if (production && versionCible < versionActuelle) throw new Error(`migrerBase : migration descendante refusée en production (version ${versionActuelle} vers ${versionCible})`);
}
