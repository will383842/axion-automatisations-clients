import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { lireDemandePassage, lireDemandePreuve } from "../../catalogue/procedure.js";
import type { Cycle } from "../../catalogue/preuves.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Cycle de vie des versions (T4-27b) : réservé à l'équipe. Deux routes seulement, aucune lecture, aucun PUT, PATCH ni DELETE.
//   POST /api/catalogue/v1/versions/:id/passages : un passage d'état (machine d'états du serveur) ;
//   POST /api/catalogue/v1/versions/:id/preuves  : une preuve d'étape de la procédure.
// Fermée (503) tant que `ouvert` est faux ; branchée dans serveur.ts seulement si l'appelant la fournit (fermé par défaut). `authentifier` (jeton d'équipe) est fourni par l'appelant et refuse en levant une ErreurApi.
export interface DepsVersionsCatalogue {
  ouvert: boolean;
  cycle: Pick<Cycle, "passer" | "deposer">;
  authentifier(requete: FastifyRequest): Promise<{ acteur: string }>;
}

export function routeVersionsCatalogue(serveur: FastifyInstance, d: DepsVersionsCatalogue): void {
  void serveur.register(async (s) => {
    // Ordre fixe : porte, équipe, puis seulement l'identifiant et le corps.
    const preparer = async (requete: FastifyRequest) => {
      if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
      const { acteur } = await d.authentifier(requete);
      const id = z.uuid().safeParse((requete.params as { id?: unknown }).id);
      if (!id.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
      return { acteur, id: id.data };
    };
    s.post("/api/catalogue/v1/versions/:id/passages", async (requete, reponse) => {
      const { acteur, id } = await preparer(requete);
      const r = await d.cycle.passer(id, lireDemandePassage(requete.body), acteur);
      return reponse.status(200).send({ version_id: r.versionId, statut: r.statut });
    });
    s.post("/api/catalogue/v1/versions/:id/preuves", async (requete, reponse) => {
      const { acteur, id } = await preparer(requete);
      const r = await d.cycle.deposer(id, lireDemandePreuve(requete.body), acteur);
      return reponse.status(201).send({ etape: r.etape });
    });
  });
}
