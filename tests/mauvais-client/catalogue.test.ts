import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeGrillesCatalogue } from "../../apps/api/src/routes/catalogue/grilles.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de la grille de prix du catalogue (T3-31a1) : une session de client, l'absence de session et une ressource absente reçoivent la même réponse
// (même statut, même corps hors identifiant de trace) et AUCUN service n'est appelé (C-536). Le catalogue est commun : aucune donnée de client.
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const SESSIONS: Record<string, { role: string }> = { "sid-client-a": { role: "client" }, "sid-equipe": { role: "administrateur" } };
let appels = 0;
const espion = (): never =>
  new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const passe = (async () => undefined) as never;
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeGrillesCatalogue(appli, {
    ouvert: true,
    exigerEquipe: (async (requete: { headers: Record<string, unknown> }) => {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
      if (!Object.hasOwn(SESSIONS, sid) || SESSIONS[sid]?.role !== "administrateur") throw new ErreurApi("action_interdite", "Action interdite.");
    }) as never,
    exigerReauthentification: passe,
    droits: { membre: async () => ({ sujet: "m1", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } }), absenceOuverte: async () => false, tracer: async () => undefined },
    acteur: async () => "equipe-essai",
    service: espion(),
  });
  await appli.ready();
});

async function jouer(methode: "GET" | "POST", url: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: methode, url, headers: sid ? { cookie: `sid=${sid}` } : {}, ...(methode === "POST" ? { payload: {} } : {}) });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
async function verifier(methode: "GET" | "POST", chemin: string) {
  const vers = (id: string) => chemin.replace(":id", id);
  const autreClient = await jouer(methode, vers(B), "sid-client-a");
  const absente = await jouer(methode, vers(ABSENT), "sid-client-a");
  const sansSession = await jouer(methode, vers(B));
  expect(autreClient).toEqual(absente);
  expect(sansSession).toEqual(absente);
  // Témoin : la même requête avec une session d'équipe passe le contrôle d'équipe.
  expect((await jouer(methode, vers(B), "sid-equipe")).statut).not.toBe(403);
  return autreClient;
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };

describe("mauvais client : routes de la grille de prix", () => {
  it("[C-536] @isolation GET /api/console/v1/catalogue/automatisations/:id/grille", async () => expect(await verifier("GET", "/api/console/v1/catalogue/automatisations/:id/grille")).toEqual(REFUS));
  it("[C-536] @isolation GET /api/console/v1/catalogue/automatisations/:id/grille/historique", async () => expect(await verifier("GET", "/api/console/v1/catalogue/automatisations/:id/grille/historique")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/catalogue/automatisations/:id/grille", async () => expect(await verifier("POST", "/api/console/v1/catalogue/automatisations/:id/grille")).toEqual(REFUS));
});
