import type { FastifyInstance } from "fastify";
import { EtatVoulu } from "../../../../../packages/contrats/src/c4/etat-voulu.js";
import { ETAT_VOULU_DE } from "../../executeur/portees.js";
import type { Contexte } from "./index.js";

// GET /instances/{id}/etat-voulu : signature de la cellule SANS jeton d'instance (l'état voulu ne contient aucun réglage). Cache 3600 s.
export function routeEtatVoulu(s: FastifyInstance, ctx: Contexte): void {
  s.get("/instances/:instanceId/etat-voulu", async (requete, reponse) => {
    const { instanceId, instance } = await ctx.instance(requete);
    const corps = EtatVoulu.parse({ instanceId, etat: ETAT_VOULU_DE[instance.etat], arretEnvois: instance.arretEnvois, version: instance.version });
    return reponse.header("cache-control", "private, max-age=3600").status(200).send(corps);
  });
}
