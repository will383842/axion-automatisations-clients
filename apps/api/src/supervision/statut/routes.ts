import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { ErreurApi } from "../../plugins/erreurs.js";
import { construirePage, validerMessage, type DepotStatut, type Incident } from "./page.js";
import type { EtatBrique } from "./composants.js";

export type { DepotStatut } from "./page.js";
// Page d'état (A-114, B-016, B-405, C-565). Fermée par défaut : sans `ouvert()` vrai, 503 et rien n'est lu.
export interface DepsStatut {
  ouvert: () => boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  etatsBriques: () => Promise<Record<string, EtatBrique>>;
  incidents: () => Promise<Incident[]>;
  depot: DepotStatut;
  maintenant: () => number;
}

export function routeStatut(serveur: FastifyInstance, d: DepsStatut): void {
  const porte = async () => { if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Page d'état indisponible."); };
  const page = async () => construirePage(await d.etatsBriques(), await d.incidents(), await d.depot.lire());

  // Publique, sans authentification : la page ne contient que des composants génériques.
  serveur.get("/api/public/v1/statut", { preHandler: [porte] }, async (_requete, reponse) => reponse.header("Cache-Control", "no-store").send(await page()));
  serveur.get("/api/console/v1/statut", { preHandler: [porte, d.exigerEquipe] }, async () => page());
  serveur.put("/api/console/v1/statut", { preHandler: [porte, d.exigerEquipe] }, async (requete) => {
    await d.depot.ecrire(validerMessage(requete.body));
    return page();
  });
}
