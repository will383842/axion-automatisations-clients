import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { PREFIXE_C4, type Configuration } from "../../../../../packages/contrats/src/c4/configuration.js";
import { avecClient } from "../../db/client-actif.js";
import { creerAuthentificationCellule, type DepsCellules } from "../../executeur/cles-cellules.js";
import { resoudreInstance, type InstanceResolue } from "../../executeur/portees.js";
import { ErreurApi } from "../../plugins/erreurs.js";
import { routeConfiguration } from "./configuration.js";
import { routeEtatVoulu } from "./etat-voulu.js";
import { routeEvenements, type DepsEvenements } from "./evenements.js";

// API de l'exécuteur (C4) : GET configuration et GET etat-voulu. Interrupteur EXECUTEUR_API_OUVERTE, fermé par défaut (seules les valeurs 1 et true ouvrent).
// Le câblage réel (pools, coffre, Valkey) dans demarrer() reste à faire : la route n'existe que si l'appelant fournit ces dépendances.
export const executeurOuvert = (env: NodeJS.ProcessEnv): boolean => env["EXECUTEUR_API_OUVERTE"] === "1" || env["EXECUTEUR_API_OUVERTE"] === "true";

export interface DepotExecuteur {
  // Lecture à chaque requête (jamais gardée) : cellule, état et arrêt des envois viennent de la base.
  resoudre(instanceId: string): Promise<InstanceResolue | null>;
  // Sous RLS avec le tenant_id résolu côté serveur ; null si aucune configuration active.
  configuration(tenantId: string, instanceId: string): Promise<Configuration | null>;
}
export interface DepsExecuteur extends DepsCellules {
  actif: () => boolean;
  depot: DepotExecuteur;
  // Réception des événements (T4-23) : la route n'existe que si ces dépendances sont fournies.
  evenements?: DepsEvenements;
}
export interface Contexte {
  deps: DepsExecuteur;
  // Authentifie la cellule PUIS rend l'instance si elle existe ET est portée par cette cellule ; sinon 404 identique dans tous les cas.
  instance(requete: FastifyRequest): Promise<{ instanceId: string; cellule: string; instance: InstanceResolue }>;
}
export const introuvable = () => new ErreurApi("introuvable", "Ressource introuvable.");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function routeExecuteur(serveur: FastifyInstance, deps: DepsExecuteur): void {
  const authentifier = creerAuthentificationCellule(deps);
  const contexte: Contexte = {
    deps,
    async instance(requete) {
      const cellule = await authentifier(requete);
      const instanceId = (requete.params as { instanceId?: string }).instanceId ?? "";
      const instance = UUID.test(instanceId) ? await deps.depot.resoudre(instanceId.toLowerCase()) : null;
      // 404 jamais 403 : une instance d'une autre cellule ressemble à une instance qui n'existe pas.
      if (!instance || instance.celluleCode !== cellule) throw introuvable();
      return { instanceId: instanceId.toLowerCase(), cellule, instance };
    },
  };
  serveur.register(async (s) => {
    // Porte fermée : refus avant toute lecture du coffre, de Valkey ou de la base.
    s.addHook("onRequest", async () => {
      if (!deps.actif()) throw new ErreurApi("porte_fermee", "Service indisponible.");
    });
    routeConfiguration(s, contexte);
    routeEtatVoulu(s, contexte);
    if (deps.evenements) routeEvenements(s, contexte, deps.evenements);
  }, { prefix: PREFIXE_C4 });
}

const DUREE_CACHE_SECONDES = 3600;
// Dépôt réel : la résolution passe par le pool de l'équipe, la configuration par le pool de l'application sous le client de l'instance.
export function depotPg(poolEquipe: Pool, poolApp: Pool): DepotExecuteur {
  return {
    resoudre: (id) => resoudreInstance(poolEquipe, id),
    async configuration(tenantId, id) {
      const { rows } = await avecClient(poolApp, tenantId, (c) =>
        c.query(
          "SELECT i.id, i.tenant_id, i.automatisation_id, i.code_automatisation, v.semver, c.donnees FROM instances AS i JOIN versions_automatisation AS v ON v.id = i.version_courante_id JOIN configurations AS c ON c.instance_id = i.id AND c.active WHERE i.id = $1 AND i.automatisation_id IS NOT NULL",
          [id],
        ),
      );
      const l = rows[0] as { id: string; tenant_id: string; automatisation_id: string; code_automatisation: string; semver: string; donnees: Record<string, unknown> } | undefined;
      return l ? ({ instanceId: l.id, clientId: l.tenant_id, automatisationId: l.automatisation_id, moduleCode: l.code_automatisation, moduleVersion: l.semver, reglages: l.donnees, dureeCacheSecondes: DUREE_CACHE_SECONDES } as Configuration) : null;
    },
  };
}
