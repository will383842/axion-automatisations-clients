import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeFileAlertes } from "../../apps/api/src/supervision/alertes/routes.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// File d'alertes de l'équipe (T5-04c) : une session de client, l'absence de session et une alerte absente reçoivent la même réponse 403 (C-536), et AUCUN service n'est appelé.
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const SESSIONS: Record<string, { acteur: string; role: string }> = { "sid-client-a": { acteur: "client-a", role: "client" }, "sid-equipe": { acteur: "membre-1", role: "dirigeant" } };
let appels = 0;
const espion = (): never => new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeFileAlertes(appli, {
    ouvert: true,
    authentifier: (async (requete: { headers: Record<string, unknown> }) => {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
      const s = Object.hasOwn(SESSIONS, sid) ? SESSIONS[sid] : undefined;
      if (!s || s.role === "client") throw new ErreurApi("action_interdite", "Action interdite.");
      return s;
    }) as never,
    droits: {
      membre: async (requete: { headers: Record<string, unknown> }) =>
        /(?:^|;\s*)sid=sid-equipe(?:;|$)/.test(String(requete.headers["cookie"] ?? "")) ? { sujet: "membre-1", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } } : undefined,
      absenceOuverte: async () => false,
      tracer: async () => undefined,
    } as never,
    lire: espion(),
    cycle: espion(),
    regles: espion(),
  });
  await appli.ready();
});

async function jouer(methode: "GET" | "POST" | "PUT", url: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: methode, url, headers: sid ? { cookie: `sid=${sid}` } : {}, ...(methode === "GET" ? {} : { payload: {} }) });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
async function verifier(methode: "GET" | "POST" | "PUT", chemin: string) {
  const vers = (id: string) => chemin.replace(":id", id);
  const autreClient = await jouer(methode, vers(B), "sid-client-a");
  const absente = await jouer(methode, vers(ABSENT), "sid-client-a");
  const sansSession = await jouer(methode, vers(B));
  expect(autreClient).toEqual(absente);
  expect(sansSession).toEqual(absente);
  expect((await jouer(methode, vers(B), "sid-equipe")).statut).not.toBe(403); // témoin : l'équipe passe le contrôle
  return autreClient;
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };

describe("mauvais client : file d'alertes", () => {
  it("[C-536] @isolation GET /api/console/v1/alertes", async () => expect(await verifier("GET", "/api/console/v1/alertes")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/alertes/:id/attribuer", async () => expect(await verifier("POST", "/api/console/v1/alertes/:id/attribuer")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/alertes/:id/commenter", async () => expect(await verifier("POST", "/api/console/v1/alertes/:id/commenter")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/alertes/:id/clore", async () => expect(await verifier("POST", "/api/console/v1/alertes/:id/clore")).toEqual(REFUS));
  it("[C-536] @isolation PUT /api/console/v1/regles-alertes/:id", async () => expect(await verifier("PUT", "/api/console/v1/regles-alertes/:id")).toEqual(REFUS));
});
