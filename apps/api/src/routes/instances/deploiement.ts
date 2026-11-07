import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErreurRegleMetier } from "../../instances/activer.js";
import { lireDemandeCreation, type DemandeCreation, type ResultatCreation } from "../../instances/creer.js";
import type { RapportTest } from "../../instances/test-a-blanc.js";
import { ErreurApi } from "../../plugins/erreurs.js";

// Déploiement d'une instance chez un client (T4-28b1, ADR 0125) : réservé à l'équipe, trois routes, aucune lecture, aucun PUT, PATCH ni DELETE.
//   POST /api/console/v1/clients/:tenantId/instances                     : créer une instance (en pause) et sa première configuration ;
//   POST /api/console/v1/clients/:tenantId/instances/:id/tests-a-blanc   : lancer un test à blanc ;
//   POST /api/console/v1/clients/:tenantId/instances/:id/activation      : activer, si toutes les gardes disent oui.
// Fermée (503) tant que `ouvert` est faux ; branchée dans serveur.ts seulement si l'appelant la fournit (absente par défaut). `authentifier` (session d'équipe) est fourni par l'appelant
// et refuse en levant une ErreurApi ; une session de client reçoit 403. Une instance d'un autre client répond 404 : on ne confirme jamais son existence.
export interface DepsDeploiementInstances {
  ouvert: boolean;
  authentifier(requete: FastifyRequest): Promise<{ acteur: string }>;
  creer(tenantId: string, acteur: string, demande: DemandeCreation): Promise<ResultatCreation>;
  tester(tenantId: string, acteur: string, instanceId: string): Promise<RapportTest>;
  activer(tenantId: string, acteur: string, instanceId: string): Promise<void>;
}

const MESSAGES_MOTIFS: Record<string, string> = {
  test_a_blanc_absent: "Aucun test à blanc réussi pour cette version et ces réglages : lancez un test à blanc.",
  test_a_blanc_echoue: "Le dernier test à blanc de cette version et de ces réglages a échoué.",
  sous_traitance_absente: "Le contrat de sous-traitance du client n'est pas signé : l'instance ne peut pas être activée.",
};
// Une règle métier de l'activation devient une réponse 422 qui nomme le motif ; une instance inconnue pour ce client devient 404.
function traduire(e: unknown): never {
  if (e instanceof ErreurRegleMetier) {
    if (e.motif === "instance_introuvable") throw new ErreurApi("introuvable", "Instance introuvable.");
    throw new ErreurApi("regle_metier", MESSAGES_MOTIFS[e.motif] ?? `Activation refusée : ${e.motif}.`);
  }
  throw e;
}

const Client = z.strictObject({ tenantId: z.uuid() });
const Instance = z.strictObject({ tenantId: z.uuid(), id: z.uuid() });
const CorpsVide = z.strictObject({});
const lire = <T>(schema: z.ZodType<T>, valeur: unknown): T => {
  const r = schema.safeParse(valeur);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};

export function routeDeploiementInstances(serveur: FastifyInstance, d: DepsDeploiementInstances): void {
  void serveur.register(async (s) => {
    // Ordre fixe : porte, équipe, puis seulement les identifiants et le corps.
    const preparer = async (requete: FastifyRequest) => {
      if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
      return (await d.authentifier(requete)).acteur;
    };
    s.post("/api/console/v1/clients/:tenantId/instances", async (requete, reponse) => {
      const acteur = await preparer(requete);
      const { tenantId } = lire(Client, requete.params);
      const r = await d.creer(tenantId, acteur, lireDemandeCreation(requete.body));
      return reponse.status(201).send({ instance_id: r.instanceId, configuration_id: r.configurationId, etat: r.etat });
    });
    s.post("/api/console/v1/clients/:tenantId/instances/:id/tests-a-blanc", async (requete, reponse) => {
      const acteur = await preparer(requete);
      const { tenantId, id } = lire(Instance, requete.params);
      lire(CorpsVide, requete.body ?? {});
      const r = await d.tester(tenantId, acteur, id);
      return reponse.status(201).send({ id: r.id, resultat: r.resultat, lectures: r.lectures, brouillons: r.brouillons, envois: r.envois, duree_ms: r.dureeMs, code_erreur: r.codeErreur });
    });
    s.post("/api/console/v1/clients/:tenantId/instances/:id/activation", async (requete, reponse) => {
      const acteur = await preparer(requete);
      const { tenantId, id } = lire(Instance, requete.params);
      lire(CorpsVide, requete.body ?? {});
      await d.activer(tenantId, acteur, id).catch(traduire);
      return reponse.status(200).send({ instance_id: id, etat: "active" });
    });
  });
}
