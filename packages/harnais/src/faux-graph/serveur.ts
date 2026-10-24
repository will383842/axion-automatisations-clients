import Fastify from "fastify";
import { creerClientMailpit, type ClientMailpit } from "../mailpit.js";
import { routesControle } from "./controle.js";
import { nouvelEtat } from "./etat.js";
import { routesGraph } from "./routes.js";

// Le faux serveur n'écoute que sur 127.0.0.1 : aucune option d'adresse n'est offerte.
const ADRESSE = "127.0.0.1";

export type FauxGraph = { url: string; adresse: string; arreter(): Promise<void> };

export async function demarrerFauxGraph(options: { mailpit?: ClientMailpit; port?: number } = {}): Promise<FauxGraph> {
  const app = Fastify({ logger: false });
  // Le jeton se demande en formulaire (application/x-www-form-urlencoded), comme chez Microsoft.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, corps, fin) =>
    fin(null, Object.fromEntries(new URLSearchParams(corps as string))),
  );
  // Un POST sans corps (comme « send ») est accepté même avec un type JSON.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, corps, fin) => {
    try {
      fin(null, corps === "" ? {} : JSON.parse(corps as string));
    } catch (e) {
      fin(e as Error, undefined);
    }
  });
  const etat = nouvelEtat();
  routesControle(app, etat);
  routesGraph(app, etat, options.mailpit ?? creerClientMailpit());
  await app.listen({ host: ADRESSE, port: options.port ?? 0 });
  const adresse = app.server.address();
  const port = typeof adresse === "object" && adresse ? adresse.port : 0;
  return { url: `http://${ADRESSE}:${port}`, adresse: ADRESSE, arreter: () => app.close() };
}
