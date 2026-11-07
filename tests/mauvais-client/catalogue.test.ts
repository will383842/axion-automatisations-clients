import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeListeCatalogue } from "../../apps/api/src/routes/catalogue/liste.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes du catalogue de l'équipe : une session de client (A) ou l'absence de session reçoit la même réponse qu'une ressource absente (403, même corps hors identifiant de trace)
// et AUCUN service n'est appelé : le catalogue n'est jamais lu pour un client (C-536).
const SESSIONS: Record<string, { role: string }> = { "sid-client-a": { role: "client" }, "sid-equipe": { role: "administrateur" } };
let appels = 0;
const espion = (): never =>
  new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeListeCatalogue(appli, {
    ouvert: true,
    exigerEquipe: async (requete) => {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
      if (!Object.hasOwn(SESSIONS, sid) || SESSIONS[sid]?.role !== "administrateur") throw new ErreurApi("action_interdite", "Action interdite.");
    },
    droits: { membre: async () => ({ sujet: "equipe-essai", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } }), absenceOuverte: async () => false, tracer: async () => undefined },
    service: espion(),
  });
  await appli.ready();
});

async function jouer(url: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: "GET", url, headers: sid ? { cookie: `sid=${sid}` } : {} });
  const corps = (r.body ? r.json() : {}) as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
async function verifier(chemin: string) {
  const autreClient = await jouer(chemin, "sid-client-a");
  const absente = await jouer(chemin, "sid-absente");
  const sansSession = await jouer(chemin);
  expect(autreClient).toEqual(absente);
  expect(sansSession).toEqual(absente);
  // Témoin : la même requête avec une session d'équipe passe le contrôle d'équipe.
  expect((await jouer(chemin, "sid-equipe")).statut).not.toBe(403);
  return autreClient;
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };

describe("mauvais client : routes du catalogue", () => {
  it("[C-536] @isolation GET /api/console/v1/catalogue", async () => expect(await verifier("/api/console/v1/catalogue")).toEqual(REFUS));
});
