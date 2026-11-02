import { idTache } from "../files/files.js";
import { NOM_TACHE, verifierTrous, type Depot, type DepsRecepteur, type FaitRange } from "./recepteur-c2.js";

// Balayage des faits rangés non traités (T2-16b, D1). La base est la source : si la file perd une tâche (Valkey redémarré après le 200,
// tâche en échec), le fait est remis en file depuis la base. Le balayage regarde aussi les sujets muets : un trou y déclenche rattrapage et alerte
// même si aucun nouveau fait n'arrive.
export const FENETRE_TENTATIVE_MS = 5 * 60 * 1000;
export const LIMITE_SUJETS_PAR_PASSAGE = 500;

export interface DepotBalayage extends Depot {
  // Sujets ayant au moins un fait non traité, les plus anciens d'abord, au plus `limite`.
  sujetsEnAttente(limite: number): Promise<{ tenantId: string; sujet: string }[]>;
  // Le fait non traité de ce sujet portant cette séquence, avec le contenu allégé rangé.
  faitAttendu(tenantId: string, sujet: string, sequence: number): Promise<FaitRange | undefined>;
}
export type DepsBalayage = Pick<DepsRecepteur, "file" | "rattrapage" | "alerter"> & { depot: DepotBalayage };

// BullMQ ignore un jobId déjà présent (tâche en attente, échouée ou conservée) : une tentative = une fenêtre de 5 minutes = un identifiant nouveau.
// Le traitement d'un fait étant idempotent (traite_le), une tâche en double est sans effet.
export const idTacheBalayage = (tenantId: string, eventId: string, maintenant: number) =>
  idTache({ tenantId, type: NOM_TACHE, cle: `${eventId}:balayage:${Math.floor(maintenant / FENETRE_TENTATIVE_MS)}` });

export async function balayer(deps: DepsBalayage, maintenant: number, limite = LIMITE_SUJETS_PAR_PASSAGE): Promise<{ remis: number; erreurs: number }> {
  if (!Number.isSafeInteger(limite) || limite < 1) throw new Error("limite de balayage invalide");
  let remis = 0;
  let erreurs = 0;
  for (const { tenantId, sujet } of await deps.depot.sujetsEnAttente(limite)) {
    // Une panne sur un sujet ne doit pas arrêter les autres : elle est comptée, et le passage suivant réessaie.
    try {
      const decision = await verifierTrous(deps, tenantId, sujet, maintenant);
      if (decision.action !== "traiter") continue;
      const fait = await deps.depot.faitAttendu(tenantId, sujet, decision.sequence);
      if (!fait) continue;
      await deps.file.add(NOM_TACHE, { tenantId, eventId: fait.eventId, sujet, sequence: fait.sequence, type: fait.type, payload: fait.payload }, { jobId: idTacheBalayage(tenantId, fait.eventId, maintenant) });
      remis++;
    } catch {
      erreurs++;
    }
  }
  return { remis, erreurs };
}
