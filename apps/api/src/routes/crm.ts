import type { FastifyInstance } from "fastify";
import { EvenementCrm } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { ROUTES_C3 } from "../../../../packages/contrats/src/c3/lecture-entreprise.js";
import { enregistrerCanal, type DepsEntrant } from "../canaux/verifier-entrant.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Un client n'est jamais créé par cette route (C-331, C-726) : elle ne fait que ranger le fait dans la file.
const PLATEFORME_ID = "00000000-0000-0000-0000-000000000001";
const PREFIXE = "/api/crm/v1";
export interface FileFaits {
  add(nom: string, donnees: unknown, opts?: { jobId?: string; attempts?: number; backoff?: { type: "exponential"; delay: number }; removeOnComplete?: { age: number }; removeOnFail?: { age: number } }): Promise<unknown>;
}
const SEPT_JOURS = 7 * 24 * 3600;
// Essais BullMQ fixés : la transaction du fait est atomique, un nouvel essai est sans risque ; au-delà, le fait reste rangé en base (balayage, dette T2-52).
export const ESSAIS_C3 = 5;
const ATTENTE_C3_MS = 2000;
export interface DepsCrm {
  entrant: DepsEntrant;
  // Range le fait en base AVANT la mise en file.
  recepteur: { recevoir(brut: unknown): Promise<{ eventId: string }> };
  file: FileFaits;
}

// POST /api/crm/v1/evenements (chemin du contrat C3). Interrupteur : entrant.actif("c3"), fermé par défaut ; branchée dans serveur.ts seulement si le dépôt C3 est fourni.
// Le fait est rangé en base avant la file ; le job ne porte que l'identifiant (aucune donnée de personne dans Valkey).
export function routeCrm(serveur: FastifyInstance, deps: DepsCrm): void {
  const chemin = ROUTES_C3.crmVersConsole.chemin.slice(PREFIXE.length);
  enregistrerCanal(serveur, "crm", deps.entrant, (s) => {
    s.post(chemin, async (requete, reponse) => {
      const lu = EvenementCrm.safeParse(requete.body);
      if (!lu.success) throw new ErreurApi("schema_invalide", "Corps invalide.");
      // Rangé d'abord (idempotent) : si la file refuse, le CRM rejoue et rien n'est rangé deux fois. Même event_id, même jobId.
      let eventId: string;
      try {
        ({ eventId } = await deps.recepteur.recevoir(lu.data));
      } catch (e) {
        // Seule une séquence hors borne est un corps invalide (400) ; une panne de la base reste une erreur 5xx que le CRM rejoue.
        if (e instanceof Error && e.message === "sequence_hors_borne") throw new ErreurApi("schema_invalide", "Corps invalide.");
        throw e;
      }
      await deps.file.add("crm-fait", { tenantId: PLATEFORME_ID, eventId }, { jobId: eventId, attempts: ESSAIS_C3, backoff: { type: "exponential", delay: ATTENTE_C3_MS }, removeOnComplete: { age: SEPT_JOURS }, removeOnFail: { age: SEPT_JOURS } });
      return reponse.status(200).send({ statut: "recu" });
    });
  });
}
