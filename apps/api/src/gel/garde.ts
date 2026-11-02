import { ErreurApi } from "../plugins/erreurs.js";
import type { GelLitige } from "../retention/purger.js";

export type ActionSousGel = "purge" | "retrait_dumps" | "retrait_exports" | "preavis" | "mise_a_l_ecart" | "effacement";

// Refus `regle_metier` motif `gel_pour_litige` : appelée par TOUT chemin qui retire quelque chose (T2-11 purge, T2-39 dumps, T2-42 exports,
// T2-44 préavis, T2-45 mise à l'écart et effacement). Le motif est porté par l'erreur ; la garde de CI (scripts/garde-gel.ts) trouve les oublis.
export class GelPourLitige extends ErreurApi {
  readonly motif = "gel_pour_litige";
  constructor(readonly action: ActionSousGel) { super("regle_metier", "Un gel pour litige est en cours : action refusée."); }
}
export async function exigerAucunGel(gel: Pick<GelLitige, "gelActif">, tenantId: string, action: ActionSousGel): Promise<void> {
  if (await gel.gelActif(tenantId)) throw new GelPourLitige(action);
}
// À appeler dans la transaction finale d'une mise à l'écart ou d'un effacement : le gel est relu juste avant le retrait, un gel posé entre-temps l'emporte.
// L'adaptateur SQL fournit un gelActif lu dans cette même transaction (dette LOT2-dette-T2-43-adaptateur).
export async function retirerSousGel<T>(gel: Pick<GelLitige, "gelActif">, tenantId: string, action: ActionSousGel, retrait: () => Promise<T>): Promise<T> {
  await exigerAucunGel(gel, tenantId, action);
  return retrait();
}
