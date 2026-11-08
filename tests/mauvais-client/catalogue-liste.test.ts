import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeListeCatalogue } from "../../apps/api/src/routes/catalogue/liste.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de la liste du catalogue (T3-40a) : une session de client, l'absence de session reçoivent la même réponse et AUCUN service n'est appelé (C-536). Catalogue commun.
const SESSIONS: Record<string, { role: string }> = { "sid-client-a": { role: "client" }, "sid-equipe": { role: "administrateur" } };
let appels = 0;
const espion = (): never => new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return { automatisations: [], proches: [], bloquant: false }; } }) as never;
let appli: ReturnType<typeof fastifyVide>;
beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeListeCatalogue(appli, {
    ouvert: true,
    exigerEquipe: (async (requete: { headers: Record<string, unknown> }) => {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
      if (!Object.hasOwn(SESSIONS, sid) || SESSIONS[sid]?.role !== "administrateur") throw new ErreurApi("action_interdite", "Action interdite.");
    }) as never,
    droits: { membre: async () => ({ sujet: "m1", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } }), absenceOuverte: async () => false, tracer: async () => undefined },
    acteur: async () => "equipe-essai",
    service: espion(),
  });
  await appli.ready();
});
async function verifier(methode: "GET" | "POST", url: string) {
  const jouer = async (sid?: string) => {
    const avant = appels;
    const r = await appli.inject({ method: methode, url, headers: sid ? { cookie: `sid=${sid}` } : {}, ...(methode === "POST" ? { payload: {} } : {}) });
    const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
    if (corps.erreur) delete corps.erreur.id_trace;
    return { statut: r.statusCode, corps, appels: appels - avant };
  };
  const client = await jouer("sid-client-a");
  expect(await jouer()).toEqual(client);
  expect((await jouer("sid-equipe")).statut).not.toBe(403);
  return client;
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };
describe("mauvais client : routes de la liste du catalogue", () => {
  it("[C-536] @isolation GET /api/console/v1/catalogue", async () => expect(await verifier("GET", "/api/console/v1/catalogue")).toEqual(REFUS));
  it("[C-536] @isolation GET /api/console/v1/catalogue/recherche", async () => expect(await verifier("GET", "/api/console/v1/catalogue/recherche?q=ab")).toEqual(REFUS));
  it("[C-536] @isolation GET /api/console/v1/catalogue/doublons", async () => expect(await verifier("GET", "/api/console/v1/catalogue/doublons?nom=ab")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/catalogue/synonymes", async () => expect(await verifier("POST", "/api/console/v1/catalogue/synonymes")).toEqual(REFUS));
});
