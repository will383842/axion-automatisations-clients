import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { ErreurApi } from "../plugins/erreurs.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export function routeSante(serveur: FastifyInstance): void {
  serveur.get("/sante", async () => ({ etat: "ok", version }));
  // Prêt : la base répond, avec le rôle attendu. Aucun détail technique en cas d'échec.
  serveur.get("/sante/pret", async () => {
    try {
      const lignes = (await serveur.base?.query("SELECT current_user AS role"))?.rows as { role?: string }[] | undefined;
      if (lignes?.[0]?.role === "console_app") return { etat: "pret" };
    } catch {
      // volontairement muet : le détail ne sort jamais
    }
    throw new ErreurApi("porte_fermee", "Service indisponible.");
  });
}
