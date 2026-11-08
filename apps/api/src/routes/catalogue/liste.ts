import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { ServiceCatalogue } from "../../catalogue/recherche.js";
import { exigerDroit, type DepsDroits } from "../../droits/exiger-droit.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Liste, recherche et doublons du catalogue (T3-40a, ADR 0139) : routes de l'équipe, catalogue commun (aucune donnée de client). Fermées tant que `ouvert` est faux.
//   GET  /api/console/v1/catalogue            : filtres combinés, tri, pagination par curseur ;
//   GET  /api/console/v1/catalogue/recherche  : recherche par mots, synonymes, sans accent ;
//   GET  /api/console/v1/catalogue/doublons   : signal de doublon (ne bloque jamais) ;
//   POST /api/console/v1/catalogue/synonymes  : ajout d'un synonyme, dirigeant seul (droit « publier_catalogue », contrôlé côté serveur).
// Ordre fixe des crochets : porte (503), équipe, droit ; ensuite seulement paramètres et corps.
export interface DepsListeCatalogue {
  ouvert: boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  droits: DepsDroits;
  acteur(requete: FastifyRequest): Promise<string>;
  service: ServiceCatalogue;
}
const GLOBALE = "Catalogue commun : aucune donnée de client.";

export function routeListeCatalogue(serveur: FastifyInstance, d: DepsListeCatalogue): void {
  void serveur.register(async (s) => {
    const base = "/api/console/v1/catalogue";
    const porte: preHandlerAsyncHookHandler = async () => {
      if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
    };
    const lecture = { preHandler: [porte, d.exigerEquipe, exigerDroit("lire", d.droits, { globale: GLOBALE })] };
    const ecriture = { preHandler: [porte, d.exigerEquipe, exigerDroit("publier_catalogue", d.droits, { globale: GLOBALE })] };
    s.get(base, lecture, async (requete) => d.service.lister(requete.query));
    s.get(`${base}/recherche`, lecture, async (requete) => d.service.rechercher(requete.query));
    s.get(`${base}/doublons`, lecture, async (requete) => d.service.doublons(requete.query));
    s.post(`${base}/synonymes`, ecriture, async (requete, reponse) => reponse.status(201).send(await d.service.ecrireSynonyme(requete.body, await d.acteur(requete))));
  });
}
