import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { leverGel, poserGel, type DepsGel, type Gel, type SessionEquipe } from "../gel/gel.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Gel pour litige (C-609) : routes de l'équipe. Le client actif (clientActifId) vient de la session, comparé au client de l'URL ; l'auteur aussi.
// Non branchées dans serveur.ts tant qu'une tâche ne câble pas les routes de l'équipe (même état que routes/reglages.ts).
export interface DepsRoutesGel {
  exigerEquipe: preHandlerAsyncHookHandler;
  exigerReauthentification: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<SessionEquipe>;
  gel: DepsGel;
}
const Params = z.strictObject({ id: z.uuid() });
const ParamsLever = z.strictObject({ id: z.uuid(), idGel: z.uuid() });
const Pose = z.strictObject({ motif: z.string().trim().min(1).max(500), posee_le: z.iso.datetime().optional() });
const Levee = z.strictObject({ motif: z.string().trim().min(1).max(500) });
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};
const dto = (g: Gel) => ({ id: g.id, motif: g.motif, posee_le: g.poseeLe.toISOString(), posee_par: g.poseePar, levee_le: g.leveeLe?.toISOString() ?? null, leve_par: g.levePar });

export function routeGel(serveur: FastifyInstance, d: DepsRoutesGel): void {
  const base = "/api/console/v1/clients/:id/gel";
  const ecriture = { preHandler: [d.exigerEquipe, d.exigerReauthentification] };
  serveur.get(base, { preHandler: d.exigerEquipe }, async (req) => {
    const { id } = lire(Params, req.params);
    if ((await d.session(req)).clientActifId !== id) throw new ErreurApi("action_interdite", "Client différent de la session.");
    return { gels: (await d.gel.depot.lister(id)).map(dto) };
  });
  serveur.post(base, ecriture, async (req, rep) => {
    const { id } = lire(Params, req.params);
    const c = lire(Pose, req.body);
    return rep.status(201).send(dto(await poserGel(d.gel, await d.session(req), id, c.motif, c.posee_le ? new Date(c.posee_le) : undefined)));
  });
  serveur.post(`${base}/:idGel/lever`, ecriture, async (req) => {
    const { id, idGel } = lire(ParamsLever, req.params);
    const c = lire(Levee, req.body);
    return dto(await leverGel(d.gel, await d.session(req), id, idGel, c.motif));
  });
}
