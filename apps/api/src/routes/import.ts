import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import { ErreurDonneesInterdites } from "../import/donnees-interdites.ts";
import { importerPersonnes, type PortsImport, type SessionImport } from "../import/importer.ts";

// POST /api/v1/import/personnes : seul chemin d'entrée d'un fichier de personnes (T2-47b). Fermée (503) tant que `ouvert` est faux (fermé par défaut).
// La session (acteur, établissement) et la base viennent de l'appelant, jamais du corps : un champ inconnu dans le corps est refusé.
// verifierImport est appelé par importerPersonnes ; un refus est validé (COMMIT) pour garder sa trace, puis renvoyé en 422 sans aucune valeur du fichier.
export interface DepsImport {
  ouvert: boolean;
  session(requete: FastifyRequest): Promise<SessionImport>;
  ports(session: SessionImport): PortsImport;
}
const LIGNES_MAX = 5000;
const Corps = z.strictObject({
  colonnes: z.array(z.string().max(200)).max(200),
  lignes: z.array(z.record(z.string().max(200), z.string().max(2000))).max(LIGNES_MAX),
});

export function routeImport(serveur: FastifyInstance, d: DepsImport): void {
  serveur.post("/api/v1/import/personnes", { bodyLimit: 5_000_000 }, async (requete) => {
    if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
    const session = await d.session(requete);
    const corps = Corps.safeParse(requete.body);
    if (!corps.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
    try {
      return await importerPersonnes(d.ports(session), session, corps.data);
    } catch (e) {
      if (e instanceof ErreurDonneesInterdites) throw new ErreurApi("regle_metier", e.message);
      throw e;
    }
  });
}
