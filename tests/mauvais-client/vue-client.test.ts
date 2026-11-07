import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeVueClient } from "../../apps/api/src/routes/equipe/vue-client.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de la vue « comme le client » (T3-08a) : l'utilisateur du client A (session de client, pas de rôle d'équipe) vise le client B.
// La réponse est celle d'une ressource refusée, identique à celle d'un client absent, et AUCUNE dépendance n'est appelée (C-536).
// Le contrôle d'équipe est celui de la session (cookie « sid »), jamais un en-tête choisi par l'appelant.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const SESSIONS: Record<string, { role: string }> = { "sid-client-a": { role: "client" }, "sid-equipe": { role: "administrateur" } };
let appels = 0;
const espion = (): never => new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const sessionDe = (requete: { headers: Record<string, unknown> }) => {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
  const s = Object.hasOwn(SESSIONS, sid) ? SESSIONS[sid] : undefined;
  return s && s.role === "administrateur" ? s : undefined;
};
const exigerDroit = async (requete: { headers: Record<string, unknown> }) => { if (!sessionDe(requete)) throw new ErreurApi("action_interdite", "Action interdite."); };
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeVueClient(appli, { garde: espion(), exigerDroit: exigerDroit as never, equipe: espion(), vue: espion(), maintenant: espion(), envois: espion(), trace: espion() });
  await appli.ready();
});

async function jouer(methode: "GET" | "POST", url: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: methode, url, headers: sid ? { cookie: `sid=${sid}` } : {}, payload: methode === "POST" ? { motif: "essai", page: "fiche" } : undefined });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
async function verifier(methode: "GET" | "POST", chemin: string) {
  const vers = (id: string) => chemin.replace(":id", id);
  expect(vers(B)).not.toBe(vers(ABSENT));
  const autreClient = await jouer(methode, vers(B), "sid-client-a");
  const absente = await jouer(methode, vers(ABSENT), "sid-client-a");
  const sansSession = await jouer(methode, vers(B));
  expect(autreClient).toEqual(absente);
  expect(sansSession).toEqual(absente);
  return autreClient;
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };

describe("mauvais client : vue « comme le client »", () => {
  it("[C-536] @isolation POST /api/console/v1/clients/:id/vue-client", async () => expect(await verifier("POST", "/api/console/v1/clients/:id/vue-client")).toEqual(REFUS));
  it("[C-536] @isolation GET /api/console/v1/clients/:id/vue-client", async () => expect(await verifier("GET", "/api/console/v1/clients/:id/vue-client")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/vue-client/pages", async () => expect(await verifier("POST", "/api/console/v1/clients/:id/vue-client/pages")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/vue-client/fermer", async () => expect(await verifier("POST", "/api/console/v1/clients/:id/vue-client/fermer")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/vue-client/demande-accord", async () => expect(await verifier("POST", "/api/console/v1/clients/:id/vue-client/demande-accord")).toEqual(REFUS));
  it("[C-536] la session d'équipe passe le contrôle d'équipe (le refus vient bien de la session)", async () => {
    expect((await jouer("GET", `/api/console/v1/clients/${A}/vue-client`, "sid-equipe")).statut).not.toBe(403);
  });
});
