import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type pg from "pg";
import { chargerConfig, type Config } from "./config.js";
import { brancherBase, creerPool } from "./plugins/base.js";
import { serialiseursJournal } from "./journal/serialiseur-req.js";
import { brancherErreurs } from "./plugins/erreurs.js";
import { routeSante } from "./routes/sante.js";

// journal : flux qui masque les secrets (plugins/journal.ts) ; les sérialiseurs (journal/serialiseur-req.ts) retirent la partie « ?… » de l'adresse, l'hôte et l'IP (base: {} retire aussi le nom de la machine). Sans flux, aucun journal n'est écrit (interrupteur fermé).
export function construireServeur(options: { config?: Config; pool?: pg.Pool; journal?: { write(ligne: string): void } } = {}) {
  // id_trace : toujours choisi par le serveur, l'en-tête du client est ignoré.
  const serveur = Fastify({ genReqId: () => randomUUID(), requestIdHeader: false, ...(options.journal ? { logger: { level: "info", stream: options.journal, base: {}, serializers: serialiseursJournal } } : {}) });
  brancherErreurs(serveur);
  brancherBase(serveur, options.pool);
  routeSante(serveur);
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
