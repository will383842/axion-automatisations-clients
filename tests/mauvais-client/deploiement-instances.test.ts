import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeDeploiementInstances } from "../../apps/api/src/routes/instances/deploiement.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de déploiement d'une instance (T4-28b1) : une session de client (A) qui vise une ressource du client B reçoit la réponse d'une ressource absente
// (même statut, même corps hors identifiant de trace) et AUCUN service n'est appelé : la ressource de B n'est jamais lue (C-536).
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const SESSIONS: Record<string, { role: string }> = { "sid-client-a": { role: "client" }, "sid-equipe": { role: "administrateur" } };
let appels = 0;
const espion = (): never =>
  new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeDeploiementInstances(appli, {
    ouvert: true,
    authentifier: async (requete) => {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
      if (!Object.hasOwn(SESSIONS, sid) || SESSIONS[sid]?.role !== "administrateur") throw new ErreurApi("action_interdite", "Action interdite.");
      return { acteur: "equipe-essai" };
    },
    creer: espion(),
    tester: espion(),
    activer: espion(),
  });
  await appli.ready();
});

async function jouer(url: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: "POST", url, headers: sid ? { cookie: `sid=${sid}` } : {}, payload: {} });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
async function verifier(chemin: string) {
  const vers = (id: string) => chemin.replace(":tenantId", id).replace(":id", id);
  const autreClient = await jouer(vers(B), "sid-client-a");
  const absente = await jouer(vers(ABSENT), "sid-client-a");
  const sansSession = await jouer(vers(B));
  expect(autreClient).toEqual(absente);
  expect(sansSession).toEqual(absente);
  // Témoin : la même requête avec une session d'équipe passe le contrôle d'équipe.
  expect((await jouer(vers(B), "sid-equipe")).statut).not.toBe(403);
  return autreClient;
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };

describe("mauvais client : routes de déploiement d'une instance", () => {
  it("[C-536] @isolation POST /api/console/v1/clients/:tenantId/instances", async () => expect(await verifier("/api/console/v1/clients/:tenantId/instances")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:tenantId/instances/:id/tests-a-blanc", async () => expect(await verifier("/api/console/v1/clients/:tenantId/instances/:id/tests-a-blanc")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:tenantId/instances/:id/activation", async () => expect(await verifier("/api/console/v1/clients/:tenantId/instances/:id/activation")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:tenantId/instances/:id/mises-a-jour", async () => expect(await verifier("/api/console/v1/clients/:tenantId/instances/:id/mises-a-jour")).toEqual(REFUS));
});
