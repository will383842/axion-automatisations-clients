import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";

// Reprise manuelle du provisionnement (A-224), équipe seulement. Ne touche jamais une base déjà active : la reprise ne fait que redéposer la tâche (même jobId).
export interface DepsRoutesProvisionnement {
  exigerEquipe: preHandlerAsyncHookHandler;
  etatBase(tenantId: string): Promise<string | undefined>;
  reprendre(tenantId: string): Promise<void>;
}
const Params = z.strictObject({ id: z.uuid() });

export function routeProvisionnement(serveur: FastifyInstance, d: DepsRoutesProvisionnement): void {
  serveur.post("/api/console/v1/clients/:id/base/reprendre", { preHandler: d.exigerEquipe }, async (req, rep) => {
    const p = Params.safeParse(req.params);
    if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const etat = await d.etatBase(p.data.id);
    if (etat === undefined) throw new ErreurApi("introuvable", "Base introuvable.");
    if (etat !== "en_creation") throw new ErreurApi("action_interdite", "Cette base n'est pas en création.");
    await d.reprendre(p.data.id);
    return rep.status(202).send({ reprise: true });
  });
}
