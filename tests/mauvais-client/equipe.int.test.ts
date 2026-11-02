import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeATrancher } from "../../apps/api/src/routes/a-trancher.js";
import { routeCanaux } from "../../apps/api/src/routes/canaux.js";
import { routeGel } from "../../apps/api/src/routes/gel.js";
import { routeAnnulation, routeJournal } from "../../apps/api/src/routes/journal.js";
import { routeProvisionnement } from "../../apps/api/src/routes/provisionnement.js";
import { routeReglages } from "../../apps/api/src/routes/reglages.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de l'équipe qui portent un identifiant de client. L'utilisateur du client A (pas de rôle équipe) vise une ressource du client B :
// la réponse est celle d'une ressource absente (même statut, même corps hors identifiant de trace) et AUCUNE dépendance n'est appelée,
// donc la ressource de B n'est jamais lue (C-536).
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const GEL = "44444444-4444-4444-8444-444444444444";
let appels = 0;
// Dépendance vide : tout appel (même profond) est compté ; « then » reste indéfini pour qu'un await ne la prenne pas pour une promesse.
const espion = (): never =>
  new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const exigerEquipe = async (requete: { headers: Record<string, unknown> }) => {
  if (requete.headers["x-role"] !== "equipe") throw new ErreurApi("action_interdite", "Action interdite.");
};
let appli: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  appli = fastifyVide();
  brancherErreurs(appli);
  const o = { exigerEquipe: exigerEquipe as never };
  routeGel(appli, { ...o, exigerReauthentification: exigerEquipe as never, session: espion(), gel: espion() });
  routeATrancher(appli, { ...o, appelant: espion(), reauthentifie: espion(), appliquer: espion(), ecarter: espion() });
  routeCanaux(appli, { ...o, magasin: espion() });
  routeJournal(appli, { ...o, lire: espion() });
  routeAnnulation(appli, { ...o, contexte: espion(), annuler: espion() });
  routeProvisionnement(appli, { ...o, etatBase: espion(), reprendre: espion() });
  routeReglages(appli, { ...o, contexte: espion(), historique: espion(), modifier: espion(), revenir: espion() });
  await appli.ready();
});

async function jouer(methode: "GET" | "POST", url: string) {
  const avant = appels;
  const r = await appli.inject({ method: methode, url, payload: methode === "POST" ? { motif: "essai" } : undefined });
  const corps = r.json() as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
// `chemin` est le chemin déclaré ; ID prend la ressource de B, puis une ressource absente.
async function verifier(methode: "GET" | "POST", chemin: string) {
  const vers = (id: string) => chemin.replace(":tenantId", id).replace(":idGel", GEL).replace(":id", id);
  const autreClient = await jouer(methode, vers(B));
  const absente = await jouer(methode, vers(ABSENT));
  expect(autreClient).toEqual(absente);
  expect(autreClient.statut).toBe(403);
  expect(autreClient.appels).toBe(0);
}

describe("mauvais client : routes de l'équipe", () => {
  it("[C-536] @isolation GET /api/console/v1/clients/:id/gel", () => verifier("GET", "/api/console/v1/clients/:id/gel"));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/gel", () => verifier("POST", "/api/console/v1/clients/:id/gel"));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/gel/:idGel/lever", () => verifier("POST", "/api/console/v1/clients/:id/gel/:idGel/lever"));
  it("[C-536] @isolation POST /api/console/v1/a-trancher/:id/appliquer", () => verifier("POST", "/api/console/v1/a-trancher/:id/appliquer"));
  it("[C-536] @isolation POST /api/console/v1/a-trancher/:id/ecarter", () => verifier("POST", "/api/console/v1/a-trancher/:id/ecarter"));
  it("[C-536] @isolation GET /api/console/v1/canaux/echecs", () => verifier("GET", "/api/console/v1/canaux/echecs"));
  it("[C-536] @isolation POST /api/console/v1/canaux/echecs/:tenantId/:id/renvoyer", () => verifier("POST", "/api/console/v1/canaux/echecs/:tenantId/:id/renvoyer"));
  it("[C-536] @isolation GET /equipe/journal", () => verifier("GET", "/equipe/journal?entite=client&entiteId=:id"));
  it("[C-536] @isolation POST /api/console/v1/journal/:id/annuler", () => verifier("POST", "/api/console/v1/journal/12/annuler"));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/base/reprendre", () => verifier("POST", "/api/console/v1/clients/:id/base/reprendre"));
  it("[C-536] @isolation GET /api/console/v1/instances/:id/reglages/versions", () => verifier("GET", "/api/console/v1/instances/:id/reglages/versions"));
  it("[C-536] @isolation POST /api/console/v1/instances/:id/reglages", () => verifier("POST", "/api/console/v1/instances/:id/reglages"));
  it("[C-536] @isolation POST /api/console/v1/instances/:id/reglages/revenir", () => verifier("POST", "/api/console/v1/instances/:id/reglages/revenir"));
});
