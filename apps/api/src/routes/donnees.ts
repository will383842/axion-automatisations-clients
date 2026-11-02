import type { FastifyInstance, FastifyRequest } from "fastify";
import { ErreurApi } from "../plugins/erreurs.js";
import type { SessionDonnees } from "../donnees/service.js";

// Une seule route de lecture des données d'un client. Le client, la base et les établissements viennent de la session que la route fournit (jamais de l'URL, du corps, d'un en-tête ou d'un cookie) ;
// le corps ne porte que les paramètres de la requête nommée. Enregistrée par serveur.ts, seulement si l'appelant fournit ces dépendances.
export interface DepsRoutesDonnees {
  session(requete: FastifyRequest): Promise<SessionDonnees>;
  // Rôle dans l'équipe de la session d'équipe (lu par l'appelant, jamais du corps ni d'un cookie) ; absent ou illisible, une session d'équipe est refusée.
  roleEquipe?(requete: FastifyRequest): Promise<string | undefined>;
  executer(session: SessionDonnees, nom: string, parametres: unknown): Promise<unknown[]>;
}
// Comme la route de reprise du provisionnement (A-224) : ni lecteur ni qualifieur, même dans l'équipe.
const ROLES_SANS_DONNEES = new Set(["lecteur", "qualifieur"]);
const NOM = /^[a-z][A-Za-z0-9]{0,63}$/;

export function routeDonnees(serveur: FastifyInstance, d: DepsRoutesDonnees): void {
  serveur.post<{ Params: { nom: string } }>("/api/v1/donnees/:nom", async (requete) => {
    if (!NOM.test(requete.params.nom)) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const session = await d.session(requete);
    if (session.role === "equipe") {
      const role = await d.roleEquipe?.(requete).catch(() => undefined);
      if (!role || ROLES_SANS_DONNEES.has(role)) throw new ErreurApi("action_interdite", "Réservé à l'équipe.");
    }
    return { lignes: await d.executer(session, requete.params.nom, requete.body ?? {}) };
  });
}
