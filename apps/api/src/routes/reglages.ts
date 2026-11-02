import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import type { RetourReglage, VersionReglage } from "../reglages/versions.js";

// Versions des réglages d'une instance (A-175, A-176), sans écran (lot 3). Le client actif et l'auteur viennent de la session de l'équipe (T1A-08),
// fournie par l'appelant : jamais d'un paramètre ni du corps. Non branchée dans serveur.ts tant qu'une tâche ne câble pas les routes de l'équipe.
export interface Contexte { tenantId: string; acteur: string }
export interface DepsReglages {
  exigerEquipe: preHandlerAsyncHookHandler;
  contexte(requete: FastifyRequest): Promise<Contexte>;
  historique(c: Contexte, instance: string): Promise<VersionReglage[]>;
  modifier(c: Contexte, instance: string, donnees: unknown, motif: string): Promise<VersionReglage>;
  revenir(c: Contexte, instance: string, numero: number, motif?: string): Promise<RetourReglage>;
}

const Params = z.strictObject({ id: z.uuid() });
const Modification = z.strictObject({ donnees: z.record(z.string(), z.unknown()), motif: z.string().trim().min(1).max(500) });
const Retour = z.strictObject({ numero: z.number().int().min(1).max(2_147_483_647), motif: z.string().trim().min(1).max(500).optional() });
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};

export function routeReglages(serveur: FastifyInstance, d: DepsReglages): void {
  const base = "/api/console/v1/instances/:id/reglages";
  const o = { preHandler: d.exigerEquipe };
  serveur.get(`${base}/versions`, o, async (req) => ({ versions: await d.historique(await d.contexte(req), lire(Params, req.params).id) }));
  serveur.post(base, o, async (req, rep) => {
    const { id } = lire(Params, req.params);
    const c = lire(Modification, req.body);
    return rep.status(201).send(await d.modifier(await d.contexte(req), id, c.donnees, c.motif));
  });
  serveur.post(`${base}/revenir`, o, async (req, rep) => {
    const { id } = lire(Params, req.params);
    const c = lire(Retour, req.body);
    const r = await d.revenir(await d.contexte(req), id, c.numero, c.motif);
    return rep.status(r.cree ? 201 : 200).send(r); // retour sans effet (déjà la version active) : 200 et cree:false, jamais 201
  });
}
