import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SchemaFiltres, VUE_PRETE_ABONNEMENTS } from "../../clients/liste.js";
import { BASE, lire, membreAutorise, type DepsClients } from "./liste.js";

const Vue = z.strictObject({ nom: z.string().trim().min(1).max(80), filtres: SchemaFiltres });

// Vues enregistrées de l'écran « clients » : par membre (sujet de la session), la vue prête « Mes abonnements » (B-320) toujours en tête.
export function routeVues(serveur: FastifyInstance, d: DepsClients, pre: { preHandler: unknown[] }): void {
  const opts = pre as never;
  serveur.get(`${BASE}/vues`, opts, async (req) => {
    const m = await membreAutorise(d, req);
    return { vues: [VUE_PRETE_ABONNEMENTS, ...(await d.vues.lister(m.sujet))] };
  });
  serveur.post(`${BASE}/vues`, opts, async (req, rep) => {
    const corps = lire(Vue, req.body);
    const m = await membreAutorise(d, req);
    return rep.status(201).send(await d.vues.creer(m.sujet, corps));
  });
}
