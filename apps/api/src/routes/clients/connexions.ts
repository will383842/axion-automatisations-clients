import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { type DepsDroits, exigerDroit } from "../../droits/exiger-droit.js";
import { versVues, type LigneConnexion } from "../../connexions/vue.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Connexions d'un client (T3-17a) : lecture seule, réservée à l'équipe (droit « lire »). Client hors portée : 404 sans lecture. 503 tant que `ouvert()` est faux (fermé par défaut).
// Aucune lecture de variable d'environnement ici : la porte est un booléen fourni par l'appelant (ADR 0133).
export interface DepsConnexions {
  ouvert(): boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  droits: DepsDroits;
  // Réservée aux actions de T3-17c (acteur de la session) ; la lecture n'en a pas besoin.
  session(requete: FastifyRequest): Promise<{ acteur: string }>;
  lire(clientId: string): Promise<LigneConnexion[]>;
}
const Params = z.strictObject({ id: z.uuid() });

export function routeConnexions(serveur: FastifyInstance, d: DepsConnexions): void {
  serveur.get(
    "/api/console/v1/clients/:id/connexions",
    { preHandler: [d.exigerEquipe, exigerDroit("lire", d.droits, { client: (r) => (r.params as { id?: unknown }).id })] },
    async (req) => {
      if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Service indisponible.");
      const p = Params.safeParse(req.params);
      if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
      return { connexions: versVues(await d.lire(p.data.id)) };
    },
  );
}
