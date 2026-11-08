import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { AccesEnCours } from "../../equipe/acces-en-cours.ts";
import { listerSessions, revoquerSession, type DepsSessions } from "../../equipe/sessions.ts";
import { exigerDroit, type DepsDroits } from "../../droits/exiger-droit.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Sécurité de l'équipe : sessions (T3-07b). Action « utilisateurs_roles » (dirigeant seul), route globale : aucune donnée de client.
// GET : porte → jeton → droit. POST : porte → jeton → réauthentification (C-003) → droit → service → trace.
// `ouvert` (SECURITE_EQUIPE_OUVERTE) est fermé par défaut : 503 « porte_fermee ». L'API s'authentifie par l'en-tête Authorization, jamais par cookie.
export interface DepsRoutesSessions {
  ouvert: boolean;
  exigerJeton: preHandlerAsyncHookHandler;
  exigerReauthentification: preHandlerAsyncHookHandler;
  droits: DepsDroits;
  sessions: DepsSessions;
  acces: AccesEnCours;
}
const Revoquer = z.strictObject({ id: z.uuid(), session: z.uuid() });
const GLOBALE = "Sécurité de l'équipe : aucune donnée de client";

export function routeSessions(serveur: FastifyInstance, d: DepsRoutesSessions): void {
  const porte: preHandlerAsyncHookHandler = async () => {
    if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
  };
  const droit = exigerDroit("utilisateurs_roles", d.droits, { globale: GLOBALE });
  serveur.get("/api/console/v1/equipe/sessions", { preHandler: [porte, d.exigerJeton, droit] }, async () => ({
    membres: await listerSessions(d.sessions),
    acces_en_cours: (await d.acces.lister().catch(() => { throw new ErreurApi("porte_fermee", "Service indisponible."); })).map((a) => ({ type: a.type, client_id: a.clientId, debut: a.debut, fin: a.fin })),
  }));
  serveur.post("/api/console/v1/equipe/membres/:id/sessions/:session/revoquer", { preHandler: [porte, d.exigerJeton, d.exigerReauthentification, droit] }, async (req, rep) => {
    const p = Revoquer.safeParse(req.params);
    if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const acteur = await d.droits.membre(req);
    if (!acteur?.actif) throw new ErreurApi("action_interdite", "Action non permise.");
    await revoquerSession(d.sessions, { acteur: acteur.sujet, membreId: p.data.id, sessionId: p.data.session });
    return rep.status(204).send();
  });
}
