import type { FastifyInstance, FastifyRequest } from "fastify";
import { ErreurApi } from "../plugins/erreurs.js";
import type { SessionDonnees } from "../donnees/service.js";

// Une seule route de lecture des données d'un client. Le client, la base et les établissements viennent de la session que la route fournit (jamais de l'URL, du corps, d'un en-tête ou d'un cookie) ;
// le corps ne porte que les paramètres de la requête nommée. L'enregistrement dans serveur.ts est une dette (T2-35).
export interface DepsRoutesDonnees {
  session(requete: FastifyRequest): Promise<SessionDonnees>;
  executer(session: SessionDonnees, nom: string, parametres: unknown): Promise<unknown[]>;
}
const NOM = /^[a-z][A-Za-z0-9]{0,63}$/;

export function routeDonnees(serveur: FastifyInstance, d: DepsRoutesDonnees): void {
  serveur.post<{ Params: { nom: string } }>("/api/v1/donnees/:nom", async (requete) => {
    if (!NOM.test(requete.params.nom)) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const session = await d.session(requete);
    return { lignes: await d.executer(session, requete.params.nom, requete.body ?? {}) };
  });
}
