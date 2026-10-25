import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type pg from "pg";
import { chargerConfig, type Config } from "./config.js";
import { brancherBase, creerPool } from "./plugins/base.js";
import { brancherErreurs } from "./plugins/erreurs.js";
import { routeSante } from "./routes/sante.js";

export function construireServeur(options: { config?: Config; pool?: pg.Pool } = {}) {
  // id_trace : toujours choisi par le serveur, l'en-tête du client est ignoré.
  const serveur = Fastify({ genReqId: () => randomUUID(), requestIdHeader: false });
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
