import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeMembres } from "../../apps/api/src/routes/equipe/membres.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de sécurité de l'équipe (T3-07c) : membres. Un utilisateur d'un client présente un jeton qui n'est pas celui de l'équipe : réponse identique quel que soit
// l'identifiant visé (membre ou client de la portée), et AUCUNE dépendance n'est appelée, donc rien d'un autre client n'est lu (C-536).
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
let appels = 0;
const espion = (): never =>
  new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const refuseTout = async () => { throw new ErreurApi("action_interdite", "Action interdite."); };
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeMembres(appli, { ouvert: true, exigerJeton: refuseTout as never, exigerReauthentification: refuseTout as never, droits: espion(), service: espion() });
  await appli.ready();
});

async function jouer(methode: "GET" | "POST", url: string, cible: string) {
  const avant = appels;
  const r = await appli.inject({ method: methode, url: url.replace(":id", cible), headers: { authorization: "Bearer jeton-de-client" }, payload: methode === "POST" ? { client: cible } : undefined });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
async function verifier(methode: "GET" | "POST", chemin: string) {
  const autre = await jouer(methode, chemin, B);
  const absent = await jouer(methode, chemin, ABSENT);
  expect(autre).toEqual(absent);
  expect(autre.appels).toBe(0);
  return autre.statut;
}

describe("mauvais client : routes de sécurité de l'équipe (membres)", () => {
  it("[C-536] @isolation GET /api/console/v1/equipe/membres", async () => expect(await verifier("GET", "/api/console/v1/equipe/membres")).toBe(403));
  it("[C-536] @isolation POST /api/console/v1/equipe/membres", async () => expect(await verifier("POST", "/api/console/v1/equipe/membres")).toBe(403));
  it("[C-536] @isolation POST /api/console/v1/equipe/membres/:id/desactiver", async () => expect(await verifier("POST", "/api/console/v1/equipe/membres/:id/desactiver")).toBe(403));
});
