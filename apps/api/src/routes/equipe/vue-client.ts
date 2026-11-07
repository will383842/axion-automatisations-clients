import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../../plugins/erreurs.js";
import type { DepsVue } from "../../donnees/vue-client.js";
import type { EnvoisService } from "../../envois/service.js";
import type { DepsGarde } from "../../vue-client/garde-lecture-seule.js";
import { ouvrirVue } from "../../vue-client/ouvrir.js";
import { consignerOuverture, demanderAccord, tracerFermeture, tracerPage, type PortTrace } from "../../vue-client/trace.js";

// « Voir comme le client » (T3-08a) : routes de l'équipe, séparées de la fiche client. Le client vient de l'URL ET doit être celui de la vue rangée côté serveur ;
// l'acteur vient de la session. `exigerDroit` pose l'action `voir_comme_client` de la matrice (T3-06) ; le rôle d'équipe est revérifié par ouvrirVueClient (T2-37).
// Non branchées dans serveur.ts sans `vueClient` (fermé par défaut).
export interface DepsVueClient {
  garde: DepsGarde;
  exigerDroit: preHandlerAsyncHookHandler;
  equipe(requete: FastifyRequest): Promise<{ acteur: string; roleEquipe: string | undefined } | undefined>;
  vue: Pick<DepsVue, "accordValide" | "finIntervention">;
  maintenant(): Date;
  envois: EnvoisService;
  trace: PortTrace;
}
const Params = z.strictObject({ id: z.uuid() });
const Ouverture = z.strictObject({ motif: z.string() });
const Page = z.strictObject({ page: z.string() });
const Vide = z.strictObject({});
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};
const absent = () => new ErreurApi("introuvable", "Ressource introuvable.");

export function routeVueClient(serveur: FastifyInstance, d: DepsVueClient): void {
  const base = "/api/console/v1/clients/:id/vue-client";
  const opt = { preHandler: d.exigerDroit };
  const membre = async (req: FastifyRequest) => (await d.equipe(req)) ?? (() => { throw absent(); })();
  const vueDe = async (req: FastifyRequest, id: string) => {
    const v = d.garde.registre.vueRangee((await membre(req)).acteur, id);
    if (!v) throw absent();
    return v;
  };
  serveur.post(base, opt, async (req, rep) => {
    const { id } = lire(Params, req.params);
    const { motif } = lire(Ouverture, req.body);
    const m = await membre(req);
    const s = await ouvrirVue(d.garde.registre, { accordValide: d.vue.accordValide, finIntervention: d.vue.finIntervention, tracer: consignerOuverture(d), maintenant: d.maintenant },
      { tenantId: id, role: "equipe", acteur: m.acteur, etablissements: [] }, id, motif, m.roleEquipe);
    return rep.status(201).send({ expire_le: s.vue?.expireLe.toISOString() });
  });
  serveur.get(base, opt, async (req) => {
    const { id } = lire(Params, req.params);
    return { ouverte: true, expire_le: (await vueDe(req, id)).expireLe.toISOString() };
  });
  serveur.post(`${base}/pages`, opt, async (req) => {
    const { id } = lire(Params, req.params);
    const { page } = lire(Page, req.body);
    const v = await vueDe(req, id);
    await tracerPage(d, id, v.acteur, page);
    return { ok: true };
  });
  serveur.post(`${base}/fermer`, opt, async (req) => {
    const { id } = lire(Params, req.params);
    lire(Vide, req.body ?? {});
    const v = await vueDe(req, id);
    d.garde.registre.fermer(v.acteur);
    await tracerFermeture(d, id, v.acteur);
    return { ferme: true };
  });
  serveur.post(`${base}/demande-accord`, opt, async (req, rep) => {
    const { id } = lire(Params, req.params);
    lire(Vide, req.body ?? {});
    await demanderAccord(d, id, (await membre(req)).acteur);
    return rep.status(202).send({ envoyee: true });
  });
}
