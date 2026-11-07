import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeOutils } from "../../apps/api/src/routes/clients/outils.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Outils et compatibilité (T3-17b) : l'utilisateur d'un client (pas d'équipe) reçoit un refus, sans aucune lecture.
const B = "22222222-2222-4222-8222-222222222222";
let appels = 0;
const espion = (): never => new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const sansEquipe = async () => { throw new ErreurApi("action_interdite", "Action interdite."); };
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeOutils(appli, { ouvert: () => true, exigerEquipe: sansEquipe as never, droits: espion(), depot: espion() });
  await appli.ready();
});

const refuse = async (url: string) => {
  const avant = appels;
  const rep = await appli.inject({ method: "GET", url });
  return { statut: rep.statusCode, lectures: appels - avant };
};

describe("outils du client : mauvais client", () => {
  it("[C-536] @isolation GET /api/console/v1/clients/:id/outils", async () => { expect(await refuse(`/api/console/v1/clients/${B}/outils`)).toEqual({ statut: 403, lectures: 0 }); });
});
