import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { ErreurApi } from "../../plugins/erreurs.js";
import { LIMITE_LIGNES, lireJournaux, validerFiltre, type DepsLecture } from "./lecture.js";

// GET /api/console/v1/journaux : lecture des journaux regroupés par l'équipe (A-080). Fermée par défaut : sans `ouvert()` vrai, 503 et rien n'est lu.
// Ordre des gardes : porte, session d'équipe (un client reçoit 403), réauthentification récente (C-003), puis lecture.
export interface DepsJournaux {
  ouvert: () => boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  exigerReauthentification: preHandlerAsyncHookHandler;
  lecture: DepsLecture;
}

export function routeJournaux(serveur: FastifyInstance, d: DepsJournaux): void {
  serveur.get("/api/console/v1/journaux", {
    preHandler: [
      async () => { if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Journaux indisponibles."); },
      d.exigerEquipe,
      d.exigerReauthentification,
    ],
  }, async (requete) => {
    const filtre = validerFiltre(requete.query, (d.lecture.maintenant ?? Date.now)());
    return { lignes: await lireJournaux(d.lecture, filtre), borne: LIMITE_LIGNES };
  });
}
