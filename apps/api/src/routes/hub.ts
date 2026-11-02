import type { FastifyInstance } from "fastify";
import { enregistrerCanal, type DepsEntrant } from "../canaux/verifier-entrant.js";
import { recevoirFait, type DepsRecepteur } from "../hub/recepteur-c2.js";

// POST /api/hub/v1/faits (C2) : derrière la vérification de signature et l'interrupteur du canal (fermé par défaut, deps.entrant.actif).
// Répond 200 dès que le fait est rangé, même s'il était déjà là : sinon le Hub le renvoie pendant 72 h.
export function brancherHub(serveur: FastifyInstance, deps: { entrant: DepsEntrant; recepteur: DepsRecepteur }): void {
  // Sans alerte, un rattrapage sans effet resterait muet : on refuse de démarrer plutôt que de recevoir des faits sans filet.
  if (typeof deps.recepteur.alerter !== "function") throw new Error("brancherHub : alerter est obligatoire");
  enregistrerCanal(serveur, "hub", deps.entrant, (s) => {
    s.post("/faits", async (r, reponse) => {
      const { statut } = await recevoirFait(deps.recepteur, r.body);
      return reponse.status(200).send({ statut });
    });
  });
}
