import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeFiche } from "../../apps/api/src/routes/clients/fiche.js";
import { routeNotes } from "../../apps/api/src/routes/clients/notes.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Fiche et notes (T3-13) : l'utilisateur d'un client (pas d'équipe) ou une équipe sans portée sur le client B reçoit la réponse d'une ressource absente, sans lecture.
const B = "22222222-2222-4222-8222-222222222222";
const N = "55555555-5555-4555-8555-555555555555";
let appels = 0;
const espion = (): never => new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const sansEquipe = async () => { throw new ErreurApi("action_interdite", "Action interdite."); };
const horsPortee = async () => ({ acteur: "agent-essai", peutVoir: () => false });
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  routeFiche(appli, { ouvert: () => true, exigerEquipe: sansEquipe as never, session: horsPortee, lire: espion() });
  routeNotes(appli, { ouvert: () => true, exigerEquipe: sansEquipe as never, session: horsPortee, lister: espion(), ajouter: espion(), epingler: espion(), noterAppelEtClore: espion(), tracer: espion() });
  await appli.ready();
});

const refuse = async (methode: "GET" | "POST", url: string, payload?: object) => {
  const avant = appels;
  const rep = await appli.inject({ method: methode, url, ...(payload ? { payload } : {}) });
  expect(rep.statusCode).toBe(403);
  expect(appels).toBe(avant);
};

describe("fiche client : mauvais client", () => {
  it("[C-536] @isolation GET /api/console/v1/clients/:id/fiche", async () => { await refuse("GET", `/api/console/v1/clients/${B}/fiche`); });
  it("[C-536] @isolation GET /api/console/v1/clients/:id/notes", async () => { await refuse("GET", `/api/console/v1/clients/${B}/notes`); });
  it("[C-536] @isolation POST /api/console/v1/clients/:id/notes", async () => { await refuse("POST", `/api/console/v1/clients/${B}/notes`, { type: "note", texte: "x" }); });
  it("[C-536] @isolation POST /api/console/v1/clients/:id/notes/:idNote/epingler", async () => { await refuse("POST", `/api/console/v1/clients/${B}/notes/${N}/epingler`, { epinglee: true }); });
  it("[C-536] @isolation POST /api/console/v1/clients/:id/notes/appel-et-cloture", async () => { await refuse("POST", `/api/console/v1/clients/${B}/notes/appel-et-cloture`, { texte: "x", alerte_id: N }); });
});
