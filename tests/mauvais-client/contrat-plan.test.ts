import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routePlan } from "../../apps/api/src/routes/clients/plan.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Onglet Contrat et plan (T3-14a) : l'utilisateur d'un client (pas d'équipe) ou une équipe sans portée sur le client B reçoit la réponse d'une ressource absente, sans lecture.
const B = "22222222-2222-4222-8222-222222222222";
let appels = 0;
const espion = (): never => new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const sansEquipe = async () => { throw new ErreurApi("action_interdite", "Action interdite."); };
const horsPortee = async () => ({ acteur: "agent-essai", peutVoir: () => false });
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routePlan(appli, { ouvert: () => true, exigerEquipe: sansEquipe as never, session: horsPortee, lire: espion() });
  await appli.ready();
});

const refuse = async (url: string) => {
  const avant = appels;
  const rep = await appli.inject({ method: "GET", url });
  return { statut: rep.statusCode, lectures: appels - avant };
};

describe("contrat et plan : mauvais client", () => {
  it("[C-536] @isolation GET /api/console/v1/clients/:id/plan", async () => { expect(await refuse(`/api/console/v1/clients/${B}/plan`)).toEqual({ statut: 403, lectures: 0 }); });
});
