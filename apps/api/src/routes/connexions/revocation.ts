import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../../plugins/erreurs.js";
import { exigerDroitSecrets, type SessionConnexions } from "./liens.js";

// Révoquer une connexion (T4-42b, A-393) : route de l'équipe, FERMÉE (non branchée dans serveur.ts). Geste d'une personne autorisée (droit sur les secrets) ET réauthentifiée ;
// l'auteur vient de la session. Le port « revoquer » est celui du courtier (revoquerConnexion) : l'API ne l'importe pas.
export type SessionRevocation = SessionConnexions;
export interface DepsRevocationConnexion {
  exigerEquipe: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<SessionRevocation>;
  revoquer(demande: { tenantId: string; connexionId: string; acteur: string; motif: "demande_client" | "decision_dirigeant" }): Promise<
    { etat: "revoquee"; effacement: "fait" | "a_refaire" } | { etat: "deja_revoquee" | "inconnue" | "refusee" }
  >;
}

const Params = z.strictObject({ id: z.uuid(), connexionId: z.uuid() });
const Corps = z.strictObject({ motif: z.enum(["demande_client", "decision_dirigeant"]) });
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};

export function routeRevocationConnexion(serveur: FastifyInstance, d: DepsRevocationConnexion): void {
  serveur.post("/api/console/v1/clients/:id/connexions/:connexionId/revoquer", { preHandler: d.exigerEquipe }, async (req) => {
    const { id, connexionId } = lire(Params, req.params);
    const { motif } = lire(Corps, req.body);
    const session = await d.session(req);
    const acteur = exigerDroitSecrets(session, id);
    if (!session.reauthentifie) throw new ErreurApi("reauthentification_requise", "Reconnectez-vous pour continuer.");
    const r = await d.revoquer({ tenantId: id, connexionId, acteur, motif });
    if (r.etat === "inconnue") throw new ErreurApi("introuvable", "Ressource introuvable.");
    if (r.etat === "deja_revoquee") throw new ErreurApi("identifiant_deja_pris", "Connexion déjà révoquée.");
    if (r.etat === "refusee") throw new ErreurApi("action_interdite", "Action interdite.");
    if (r.etat !== "revoquee") throw new ErreurApi("erreur_interne", "Erreur interne.");
    return { etat: "revoquee", effacement: r.effacement };
  });
}
