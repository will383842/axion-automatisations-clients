import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { exigerDroit, type DepsDroits } from "../../droits/exiger-droit.js";
import type { ServiceMembres } from "../../equipe/membres.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Membres de l'équipe (T3-07c) : action « utilisateurs_roles » (dirigeant seul), jamais une action nouvelle. Porte SECURITE_EQUIPE_OUVERTE fermée par défaut : 503.
// Chaîne de chaque geste (POST) : porte → jeton (en-tête Authorization, jamais un cookie) → réauthentification (C-003) → droit → service.
export interface DepsRoutesMembres {
  ouvert: boolean;
  exigerJeton: preHandlerAsyncHookHandler;
  exigerReauthentification: preHandlerAsyncHookHandler;
  droits: DepsDroits;
  service: ServiceMembres;
}
const BASE = "/api/console/v1/equipe/membres";
const Params = z.strictObject({ id: z.uuid() });
const CorpsVide = z.strictObject({});
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};

export function routeMembres(serveur: FastifyInstance, d: DepsRoutesMembres): void {
  const porte: preHandlerAsyncHookHandler = async () => {
    if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
  };
  const droit = exigerDroit("utilisateurs_roles", d.droits, { globale: "Sécurité de l'équipe : aucune donnée de client" });
  const lecture = { preHandler: [porte, d.exigerJeton, droit] };
  const geste = { preHandler: [porte, d.exigerJeton, d.exigerReauthentification, droit] };
  // Le membre vient de la base (relu à chaque requête par exigerDroit), jamais de la requête.
  const acteur = async (requete: FastifyRequest) => {
    const m = await d.droits.membre(requete);
    if (!m?.actif) throw new ErreurApi("action_interdite", "Action non permise.");
    return { sujet: m.sujet, role: m.role };
  };

  serveur.get(BASE, lecture, async () => ({
    membres: (await d.service.lister()).map((m) => ({ id: m.id, role: m.role, actif: m.actif, nombre_clients: m.nombreClients, cree_le: m.creeLe.toISOString(), desactive_le: m.desactiveLe?.toISOString() ?? null })),
  }));
  serveur.post(BASE, geste, async (requete, reponse) => {
    const r = await d.service.inviter(await acteur(requete), requete.body);
    return reponse.status(201).send({ id: r.id, role: r.role, nombre_clients: r.nombreClients, invitation_envoyee: r.invitationEnvoyee });
  });
  serveur.post(`${BASE}/:id/desactiver`, geste, async (requete, reponse) => {
    const { id } = lire(Params, requete.params);
    lire(CorpsVide, requete.body ?? {});
    await d.service.desactiver(await acteur(requete), id);
    return reponse.status(204).send();
  });
}
