import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export function routeSante(serveur: FastifyInstance): void {
  serveur.get("/sante", async () => ({ etat: "ok", version }));
}
