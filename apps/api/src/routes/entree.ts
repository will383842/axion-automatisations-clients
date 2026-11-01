import type { FastifyInstance } from "fastify";
import { entetesDebitDepasse } from "../../../../packages/contrats/src/commun/debit.js";
import { creerEntree, type DepsEntree } from "../entree/c6.js";

export type { DepsEntree } from "../entree/c6.js";

// Réception du lien signé C6 : POST /api/console/v1/entree, jeton dans le corps seulement.
// Tout refus (corps illisible, trop gros, mauvais type compris) donne la même réponse 200 { url : connexion normale }.
// Seule la limite d'essais répond 429. Aucun cookie, aucune session : la réponse n'est qu'une adresse.
// Non branchée dans serveur.ts : la fonction reste fermée tant qu'une tâche ne la branche pas derrière son interrupteur.
export function routeEntree(serveur: FastifyInstance, deps: DepsEntree): void {
  const entree = creerEntree(deps);
  serveur.register(async (s) => {
    s.removeAllContentTypeParsers();
    // Seul application/json est lu : tout autre type (text/plain, formulaire) est une requête « simple » d'un autre site, refusée sans lire le corps.
    s.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 4096 }, (_r, corps, fin) => fin(null, corps));
    s.setErrorHandler(async (_e, _r, reponse) => reponse.header("cache-control", "no-store").status(200).send({ url: deps.connexionNormale }));
    s.post("/api/console/v1/entree", { bodyLimit: 4096 }, async (requete, reponse) => {
      const r = await entree(requete.body, requete.ip, (requete.raw.url ?? "").includes("?"), (code) => requete.log.info({ code }, "entrée C6 refusée"));
      reponse.header("cache-control", "no-store");
      if (r.statut === 429) return reponse.header("Retry-After", entetesDebitDepasse(r.retryAfter)["Retry-After"]).status(429).send({ erreur: { code: "debit_depasse", message: "Trop de requêtes.", id_trace: requete.id } });
      return reponse.status(200).send({ url: r.url });
    });
  });
}
