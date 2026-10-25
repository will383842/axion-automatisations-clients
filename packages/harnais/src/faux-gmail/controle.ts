import type { FastifyInstance } from "fastify";
import { MODES, nouvelEtat, type EtatGmail, type Mode } from "./etat.js";

// Pilotage des pannes : refusé partout sauf quand NODE_ENV vaut « test » (lu à chaque appel).
export function routesControle(app: FastifyInstance, etat: EtatGmail): void {
  app.post("/__controle", async (req, rep) => {
    if (process.env["NODE_ENV"] !== "test") return rep.code(403).send({ error: "controle_refuse" });
    const { mode, reinitialiser } = (req.body ?? {}) as { mode?: string; reinitialiser?: boolean };
    if (!MODES.includes(mode as Mode)) return rep.code(400).send({ error: "mode_inconnu", modes: MODES });
    if (reinitialiser) Object.assign(etat, nouvelEtat());
    etat.mode = mode as Mode;
    return { mode: etat.mode };
  });
}
