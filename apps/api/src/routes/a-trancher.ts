import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { Appelant } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Appliquer ou écarter une proposition de la nuit (C-365) : équipe seulement. Comme routeJournal, la route n'est branchée dans serveur.ts
// que par la fiche qui câble les routes de l'équipe (T2-21) ; tant qu'elle ne l'est pas, elle n'existe pas.
const Id = z.object({ id: z.uuid() });
const Ecart = z.strictObject({ motif: z.string().trim().min(1).max(500) });

export interface OptionsATrancher {
  exigerEquipe: preHandlerAsyncHookHandler;
  appelant: (r: FastifyRequest) => Appelant;
  reauthentifie: (r: FastifyRequest) => boolean;
  appliquer: (id: string, appelant: Appelant, reauthentifie: boolean) => Promise<void>;
  ecarter: (id: string, appelant: Appelant, motif: string) => Promise<void>;
}

export function routeATrancher(serveur: FastifyInstance, o: OptionsATrancher): void {
  const base = "/api/console/v1/a-trancher/:id";
  serveur.post(`${base}/appliquer`, { preHandler: o.exigerEquipe }, async (requete, reponse) => {
    const p = Id.safeParse(requete.params);
    if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    await o.appliquer(p.data.id, o.appelant(requete), o.reauthentifie(requete));
    return reponse.status(204).send();
  });
  serveur.post(`${base}/ecarter`, { preHandler: o.exigerEquipe }, async (requete, reponse) => {
    const p = Id.safeParse(requete.params);
    const b = Ecart.safeParse(requete.body);
    if (!p.success || !b.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    await o.ecarter(p.data.id, o.appelant(requete), b.data.motif);
    return reponse.status(204).send();
  });
}
