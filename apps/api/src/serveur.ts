import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type pg from "pg";
import { chargerConfig, type Config } from "./config.js";
import { brancherBase, creerPool } from "./plugins/base.js";
import { serialiseursJournal } from "./journal/serialiseur-req.js";
import { brancherErreurs } from "./plugins/erreurs.js";
import { ErreurApi } from "./plugins/erreurs.js";
import { PREFIXE } from "./files/files.js";
import { executerTache, type Resultat } from "./provisionnement/machine.js";
import { routeProvisionnement, type DepsRoutesProvisionnement } from "./routes/provisionnement.js";
import { routeDonnees, type DepsRoutesDonnees } from "./routes/donnees.js";
import { routeCrm, type DepsCrm } from "./routes/crm.js";
import { routeExecuteur, type DepsExecuteur } from "./routes/executeur/index.js";
import { routeWebhooks, type DepsWebhooks } from "./routes/webhooks/entree.js";
import { routeImport, type DepsImport } from "./routes/import.js";
import { routeSante } from "./routes/sante.js";
import { routeImportCatalogue, type DepsImportCatalogue } from "./routes/catalogue/import.js";
import { routeVersionsCatalogue, type DepsVersionsCatalogue } from "./routes/catalogue/versions.js";

// journal : flux qui masque les secrets (plugins/journal.ts) ; les sérialiseurs (journal/serialiseur-req.ts) retirent la partie « ?… » de l'adresse, l'hôte et l'IP (base: {} retire aussi le nom de la machine). Sans flux, aucun journal n'est écrit (interrupteur fermé).
// exigerEquipe de la route de reprise du provisionnement (A-224) : une session d'équipe est exigée, et les rôles « lecteur » et « qualifieur » sont refusés même dans l'équipe.
const ROLES_SANS_REPRISE = new Set(["lecteur", "qualifieur"]);
export function exigerEquipeParRole(lire: (requete: Parameters<preHandlerAsyncHookHandler>[0]) => Promise<{ equipe: boolean; role: string } | undefined>): preHandlerAsyncHookHandler {
  return async (requete) => {
    const s = await lire(requete);
    if (!s || !s.equipe || ROLES_SANS_REPRISE.has(s.role)) throw new ErreurApi("action_interdite", "Réservé à l'équipe.");
  };
}

// Worker du provisionnement (A-213) : la tâche ne porte que le tenantId (jamais un chemin du coffre ni une valeur) ; un verrou pris est une erreur réessayable (executerTache).
export function creerTravailleurProvisionnement(o: {
  connexion: Redis;
  machine: { executer(tenantId: string): Promise<Resultat> };
  fabrique(nom: string, traitement: (job: { data: unknown }) => Promise<unknown>, options: Record<string, unknown>): Pick<Worker, "close">;
}): Pick<Worker, "close"> {
  return o.fabrique("provisionnement", async (job) => executerTache(o.machine, String((job.data as { tenantId?: unknown } | null)?.tenantId ?? "")), { connection: o.connexion, prefix: PREFIXE, concurrency: 1 });
}

// `provisionnement` : routes de reprise fournies par l'appelant ; absent, la route n'existe pas (fermé par défaut).
export function construireServeur(options: { config?: Config; pool?: pg.Pool; journal?: { write(ligne: string): void }; provisionnement?: DepsRoutesProvisionnement; crm?: DepsCrm; executeur?: DepsExecuteur; donnees?: DepsRoutesDonnees; importCatalogue?: DepsImportCatalogue; versionsCatalogue?: DepsVersionsCatalogue; webhooks?: DepsWebhooks; importPersonnes?: DepsImport } = {}) {
  // id_trace : toujours choisi par le serveur, l'en-tête du client est ignoré.
  const serveur = Fastify({ genReqId: () => randomUUID(), requestIdHeader: false, ...(options.journal ? { logger: { level: "info", stream: options.journal, base: {}, serializers: serialiseursJournal } } : {}) });
  brancherErreurs(serveur);
  brancherBase(serveur, options.pool);
  routeSante(serveur);
  if (options.provisionnement) routeProvisionnement(serveur, options.provisionnement);
  // Récepteur C3 : branché seulement si le dépôt, la file et l'entrant sont fournis ; la porte du canal reste fermée par défaut (503).
  // Le démarrage réel (Valkey, travailleur) reste la dette LOT2-dette-T2-14-cablage (propriétaire T2-21).
  if (options.crm) routeCrm(serveur, options.crm);
  // API de l'exécuteur (C4) : absente sans dépendances ; fournie, la porte reste fermée tant que actif() rend faux (EXECUTEUR_API_OUVERTE, fermé par défaut).
  if (options.executeur) routeExecuteur(serveur, options.executeur);
  // Service des données (T2-37c) : branché seulement si l'appelant fournit la session, le rôle d'équipe et le service ; absent, la route n'existe pas.
  if (options.donnees) routeDonnees(serveur, options.donnees);
  // Import des versions (T4-25) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert` est faux (IMPORT_OUVERT, fermé par défaut).
  if (options.importCatalogue) routeImportCatalogue(serveur, options.importCatalogue);
  // Cycle de vie des versions (T4-27b) : la route n'existe que si l'appelant la fournit, réservée à l'équipe, et répond 503 tant que `ouvert` est faux (fermé par défaut).
  if (options.versionsCatalogue) routeVersionsCatalogue(serveur, options.versionsCatalogue);
  // Webhooks entrants (T4-24) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `actif()` est faux (WEBHOOKS_OUVERTS, fermé par défaut).
  if (options.webhooks) routeWebhooks(serveur, options.webhooks);
  // Import de personnes (T2-47b) : la route n'existe que si l'appelant la fournit, et répond 503 tant que `ouvert` est faux (fermé par défaut).
  if (options.importPersonnes) routeImport(serveur, options.importPersonnes);
  return serveur;
}

// La configuration est validée avant toute ouverture : une configuration refusée ne démarre rien.
export async function demarrer(env: NodeJS.ProcessEnv = process.env) {
  const config = chargerConfig(env);
  const serveur = construireServeur({ config, ...(config.appDatabaseUrl ? { pool: creerPool(config.appDatabaseUrl) } : {}) });
  await serveur.listen({ port: config.port, host: "0.0.0.0" });
  return serveur;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  demarrer().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "démarrage impossible");
    process.exit(1);
  });
}
