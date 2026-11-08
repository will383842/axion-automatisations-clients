import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { ServiceGrilles } from "../../catalogue/grille.js";
import { exigerDroit, type DepsDroits } from "../../droits/exiger-droit.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Grille de prix d'une automatisation (T3-31a1, ADR 0135) : routes de l'équipe, catalogue commun (aucune donnée de client).
//   GET  /api/console/v1/catalogue/automatisations/:id/grille            : grille en vigueur et signal « masquée par défaut » ;
//   GET  /api/console/v1/catalogue/automatisations/:id/grille/historique : historique, une ligne par champ changé ;
//   POST /api/console/v1/catalogue/automatisations/:id/grille            : nouvelle grille (jamais de modification) ; dirigeant seul, réauthentification récente.
// Ordre fixe des crochets : porte (503), équipe, réauthentification (POST), droit ; ensuite seulement paramètres et corps.
// Fermée tant que `ouvert` est faux ; branchée dans serveur.ts seulement si l'appelant la fournit. Un second administrateur dont la portée ne couvre pas tous les clients reçoit 404, même en lecture (échec fermé voulu).
export interface DepsGrillesCatalogue {
  ouvert: boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  exigerReauthentification: preHandlerAsyncHookHandler;
  droits: DepsDroits;
  acteur(requete: FastifyRequest): Promise<string>;
  service: ServiceGrilles;
}

const Params = z.strictObject({ id: z.uuid() });
const Requete = z.strictObject({ limite: z.string().regex(/^[0-9]{1,3}$/).optional() });
const lire = <T>(schema: z.ZodType<T>, valeur: unknown): T => {
  const r = schema.safeParse(valeur);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};
const GLOBALE = "Catalogue commun : aucune donnée de client.";

export function routeGrillesCatalogue(serveur: FastifyInstance, d: DepsGrillesCatalogue): void {
  void serveur.register(async (s) => {
    const base = "/api/console/v1/catalogue/automatisations/:id/grille";
    const porte: preHandlerAsyncHookHandler = async () => {
      if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
    };
    const lecture = { preHandler: [porte, d.exigerEquipe, exigerDroit("lire", d.droits, { globale: GLOBALE })] };
    const ecriture = { preHandler: [porte, d.exigerEquipe, d.exigerReauthentification, exigerDroit("publier_catalogue", d.droits, { globale: GLOBALE })] };
    s.get(base, lecture, async (requete) => d.service.lire(lire(Params, requete.params).id));
    s.get(`${base}/historique`, lecture, async (requete) => {
      const { id } = lire(Params, requete.params);
      const { limite } = lire(Requete, requete.query);
      return { historique: await d.service.historique(id, limite === undefined ? 50 : Number(limite)) };
    });
    s.post(base, ecriture, async (requete, reponse) => {
      const { id } = lire(Params, requete.params);
      return reponse.status(201).send(await d.service.ecrire(id, await d.acteur(requete), requete.body));
    });
  });
}
