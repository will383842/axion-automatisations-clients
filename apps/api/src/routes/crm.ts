import type { FastifyInstance } from "fastify";
import { EvenementCrm } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { ROUTES_C3 } from "../../../../packages/contrats/src/c3/lecture-entreprise.js";
import { enregistrerCanal, type DepsEntrant } from "../canaux/verifier-entrant.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Un client n'est jamais créé par cette route (C-331, C-726) : elle ne fait que ranger le fait dans la file.
const PLATEFORME_ID = "00000000-0000-0000-0000-000000000001";
const PREFIXE = "/api/crm/v1";
export interface FileFaits {
  add(nom: string, donnees: unknown, opts?: { jobId?: string }): Promise<unknown>;
}
export interface DepsCrm {
  entrant: DepsEntrant;
  file: FileFaits;
}

// POST /api/crm/v1/evenements (chemin du contrat C3). Interrupteur : entrant.actif("c3"), fermé par défaut ; non branchée dans serveur.ts.
export function routeCrm(serveur: FastifyInstance, deps: DepsCrm): void {
  const chemin = ROUTES_C3.crmVersConsole.chemin.slice(PREFIXE.length);
  enregistrerCanal(serveur, "crm", deps.entrant, (s) => {
    s.post(chemin, async (requete, reponse) => {
      const lu = EvenementCrm.safeParse(requete.body);
      if (!lu.success) throw new ErreurApi("schema_invalide", "Corps invalide.");
      // Même event_id, même jobId : BullMQ ne garde qu'une tâche ; le dédoublonnage définitif est dans la transaction (faits_recus).
      await deps.file.add("crm-fait", { tenantId: PLATEFORME_ID, evenement: lu.data }, { jobId: lu.data.event_id });
      return reponse.status(200).send({ statut: "recu" });
    });
  });
}
