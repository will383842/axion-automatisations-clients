import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../../plugins/erreurs.js";
import type { SessionPortail } from "../../donnees/requetes-declarees.js";

// Lecture des données déclarées par un module (T2-49) : une seule route, LECTURE SEULE (aucune route d'écriture, T2-55). Le client vient de la session que la route fournit, jamais de l'URL, du corps,
// d'un en-tête ou d'un cookie (C-536) ; le corps ne porte que les paramètres de la requête. Fermée par défaut : `ouvert` doit être vrai.
export interface DepsRouteDonneesModule {
  ouvert: boolean;
  session(requete: FastifyRequest): Promise<SessionPortail>;
  lire(session: SessionPortail, instance: string, nom: string, parametres: unknown): Promise<unknown[]>;
}
const NOM = /^[a-z][a-z0-9-]{1,40}$/;

export function routeDonneesModule(serveur: FastifyInstance, d: DepsRouteDonneesModule): void {
  serveur.post<{ Params: { instance: string; nom: string } }>("/api/portail/v1/automatisations/:instance/donnees/:nom", async (requete) => {
    if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
    if (!z.uuid().safeParse(requete.params.instance).success || !NOM.test(requete.params.nom)) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const session = await d.session(requete);
    return { lignes: await d.lire(session, requete.params.instance, requete.params.nom, requete.body ?? {}) };
  });
}
