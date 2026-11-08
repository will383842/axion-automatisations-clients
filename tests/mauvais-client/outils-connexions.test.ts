import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeConnexions } from "../../apps/api/src/routes/clients/connexions.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Outils et connexions (T3-17) : une personne sans session d'équipe reçoit un refus, sans lecture, pour un autre client.
const B = "22222222-2222-4222-8222-222222222222";
let appels = 0;
const espion = (): never => new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const sansEquipe = async () => { throw new ErreurApi("action_interdite", "Action interdite."); };
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeConnexions(appli, { ouvert: () => true, exigerEquipe: sansEquipe as never, droits: espion(), session: espion(), lire: espion() });
  await appli.ready();
});

const refuse = async (methode: "GET" | "POST", url: string, payload?: object) => {
  const avant = appels;
  const rep = await appli.inject({ method: methode, url, ...(payload ? { payload } : {}) });
  return { statut: rep.statusCode, lectures: appels - avant };
};

describe("outils et connexions : mauvais client", () => {
  it("[C-536] @isolation GET /api/console/v1/clients/:id/connexions", async () => { expect(await refuse("GET", `/api/console/v1/clients/${B}/connexions`)).toEqual({ statut: 403, lectures: 0 }); });
});
