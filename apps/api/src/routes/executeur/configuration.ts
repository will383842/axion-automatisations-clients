import type { FastifyInstance } from "fastify";
import { Configuration } from "../../../../../packages/contrats/src/c4/configuration.js";
import { verifierJetonInstance } from "../../executeur/jeton-instance.js";
import { ErreurApi } from "../../plugins/erreurs.js";
import { introuvable, type Contexte } from "./index.js";

// GET /instances/{id}/configuration : signature de la cellule, PUIS jeton d'instance (Authorization: Instance <jeton>), PUIS base relue.
// La cellule attendue du jeton est celle qui signe (égale à celle de la base) : jamais la charge du jeton. Jeton absent, faux, périmé ou panne du coffre : le même 404.
const JETON = /^Instance (\S+)$/;

export function routeConfiguration(s: FastifyInstance, ctx: Contexte): void {
  s.get("/instances/:instanceId/configuration", async (requete, reponse) => {
    const { instanceId, cellule, instance } = await ctx.instance(requete);
    // Le jeton n'est ni révocable ni anti-rejeu : l'arrêt des envois ou une instance livrée le rend inutile dès cette requête.
    if (instance.arretEnvois || instance.etat === "livree") throw introuvable();
    const jeton = JETON.exec(typeof requete.headers.authorization === "string" ? requete.headers.authorization : "")?.[1];
    if (!jeton || !(await verifierJetonInstance(ctx.deps.cles, jeton, { instanceId, cellule }))) throw introuvable();
    const lue = await ctx.deps.depot.configuration(instance.tenantId, instanceId);
    if (!lue) throw introuvable();
    const configuration = Configuration.safeParse(lue);
    if (!configuration.success) throw new ErreurApi("erreur_interne", "Erreur interne.");
    return reponse.header("cache-control", `private, max-age=${configuration.data.dureeCacheSecondes}`).status(200).send(configuration.data);
  });
}
