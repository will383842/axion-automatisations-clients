import pg from "pg";
import type { FastifyInstance } from "fastify";
import { avecClient } from "../db/client-actif.js";

// Accès à la base : le seul rôle applicatif (console_app), par PgBouncer en mode transaction.
// Les requêtes d'un client passent par request.avecClient (T1A-03) : jamais par le pool directement.
export function creerPool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 2000, query_timeout: 2000 });
  pool.on("error", () => undefined);
  return pool;
}

declare module "fastify" {
  interface FastifyInstance {
    base?: pg.Pool;
  }
  interface FastifyRequest {
    avecClient<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  }
}

export function brancherBase(serveur: FastifyInstance, pool: pg.Pool | undefined): void {
  serveur.decorateRequest("avecClient", function (this: { server: FastifyInstance }, tenantId: string, fn: Parameters<typeof avecClient>[2]) {
    if (!this.server.base) throw new Error("base non configurée");
    return avecClient(this.server.base, tenantId, fn);
  } as never);
  if (!pool) return;
  serveur.decorate("base", pool);
  serveur.addHook("onClose", async () => void (await pool.end().catch(() => undefined)));
}
