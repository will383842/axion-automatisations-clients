import Fastify from "fastify";
import { creerClientMailpit, type ClientMailpit } from "../mailpit.js";
import { routesControle } from "./controle.js";
import { nouvelEtat } from "./etat.js";
import { routesGmail } from "./routes.js";

// Le faux serveur n'écoute que sur 127.0.0.1 : aucune option d'adresse n'est offerte.
const ADRESSE = "127.0.0.1";

export type FauxGmail = { url: string; adresse: string; arreter(): Promise<void> };

export async function demarrerFauxGmail(options: { mailpit?: ClientMailpit; port?: number } = {}): Promise<FauxGmail> {
  const app = Fastify({ logger: false });
  const etat = nouvelEtat();
  routesControle(app, etat);
  routesGmail(app, etat, options.mailpit ?? creerClientMailpit());
  await app.listen({ host: ADRESSE, port: options.port ?? 0 });
  const adresse = app.server.address();
  const port = typeof adresse === "object" && adresse ? adresse.port : 0;
  return { url: `http://${ADRESSE}:${port}`, adresse: ADRESSE, arreter: () => app.close() };
}
