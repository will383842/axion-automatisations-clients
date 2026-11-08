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
import type { OptionsBranchements } from "./routes/branchement.js";
import { BRANCHEMENTS } from "./routes/registre-branchements.js";
import { brancherGardePortail, type DepsGardePortail } from "./portail/garde.js";

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

// Une route s'inscrit par un fichier neuf dans routes/branchements/ (ADR 0139) : sa clé et ses dépendances viennent de là, fermées par défaut.
// Une clé absente (ou fausse) ne branche rien : la route n'existe pas.
export type OptionsServeur = { config?: Config; pool?: pg.Pool; journal?: { write(ligne: string): void }; portail?: DepsGardePortail } & Partial<OptionsBranchements>;
export function construireServeur(options: OptionsServeur = {}) {
  // id_trace : toujours choisi par le serveur, l'en-tête du client est ignoré.
  const serveur = Fastify({ genReqId: () => randomUUID(), requestIdHeader: false, ...(options.journal ? { logger: { level: "info", stream: options.journal, base: {}, serializers: serialiseursJournal } } : {}) });
  brancherErreurs(serveur);
  brancherBase(serveur, options.pool);
  // Garde de l'API du portail (T6-02b) : posée AVANT toute route (les crochets ne couvrent que les routes inscrites après) ; fermée par défaut, absente sans `portail`.
  if (options.portail) brancherGardePortail(serveur, options.portail);
  // Le registre est lu une fois, trié par nom de fichier ; `toujours` = branché d'office (santé), sinon seulement si l'appelant fournit la clé.
  for (const b of BRANCHEMENTS) {
    const sv = b.serveur;
    if (!sv) continue;
    if ("toujours" in sv) sv.brancher(serveur);
    else {
      const d = options[sv.cle];
      if (d) sv.brancher(serveur, d);
    }
  }
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
