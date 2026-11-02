import type { FastifyInstance, FastifyRequest } from "fastify";
import { LIMITES } from "../../catalogue/schema.js";
import type { Importeur } from "../../catalogue/importer.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// POST /api/catalogue/v1/versions : seule route du catalogue de versions. Pas de PUT, PATCH ni DELETE : une version rangée ne change plus (A-407).
// Fermée (503) tant que l'interrupteur IMPORT_OUVERT n'est pas ouvert. L'équipe (Keycloak) ou le poste de la recette (HMAC) s'authentifie par `authentifier`,
// fourni par l'appelant, qui reçoit le corps pour vérifier la signature ; il refuse en levant une ErreurApi.
export interface DepsImportCatalogue {
  ouvert: boolean;
  importeur: Importeur;
  authentifier(requete: FastifyRequest, corps: Buffer): Promise<{ acteur: string }>;
}

export function routeImportCatalogue(serveur: FastifyInstance, d: DepsImportCatalogue): void {
  void serveur.register(async (s) => {
    // Archive brute : lue en mémoire dans la limite de 20 Mo, jamais interprétée par Fastify.
    s.addContentTypeParser(["application/gzip", "application/octet-stream"], { parseAs: "buffer", bodyLimit: LIMITES.archiveOctets }, (_r, corps, fini) => fini(null, corps));
    s.post("/api/catalogue/v1/versions", { bodyLimit: LIMITES.archiveOctets }, async (requete, reponse) => {
      if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
      const corps = requete.body;
      if (!Buffer.isBuffer(corps)) throw new ErreurApi("schema_invalide", "Requête invalide.");
      await d.authentifier(requete, corps);
      const code = requete.headers["x-automatisation"];
      const r = await d.importeur.importer(corps, typeof code === "string" ? code : "");
      return reponse.status(r.cree ? 201 : 200).send({ version: r.version, signal_doublon: r.signal_doublon });
    });
  });
}
