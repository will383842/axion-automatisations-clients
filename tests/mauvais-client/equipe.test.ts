import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeATrancher } from "../../apps/api/src/routes/a-trancher.js";
import { routeCanaux } from "../../apps/api/src/routes/canaux.js";
import { routeGel } from "../../apps/api/src/routes/gel.js";
import { routeAnnulation, routeJournal } from "../../apps/api/src/routes/journal.js";
import { routeProvisionnement } from "../../apps/api/src/routes/provisionnement.js";
import { routeReglages } from "../../apps/api/src/routes/reglages.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Routes de l'équipe qui portent un identifiant de client. L'utilisateur du client A (session de client, pas de rôle équipe) vise une ressource du client B :
// la réponse est celle d'une ressource absente (même statut, même corps hors identifiant de trace) et AUCUNE dépendance n'est appelée,
// donc la ressource de B n'est jamais lue (C-536). Le refus est un 403 identique quel que soit l'identifiant : il ne dit pas si la ressource existe.
// Le contrôle d'équipe est celui de la session (cookie « sid » cherché dans le registre des sessions), jamais un en-tête choisi par l'appelant.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const GEL = "44444444-4444-4444-8444-444444444444";
const SESSIONS: Record<string, { role: string; tenantId?: string }> = {
  "sid-client-a": { role: "client", tenantId: A },
  "sid-equipe": { role: "administrateur" },
};
const ROLES_EQUIPE = new Set(["administrateur", "operateur"]);
let appels = 0;
// Dépendance vide : tout appel (même profond) est compté ; « then » reste indéfini pour qu'un await ne la prenne pas pour une promesse.
const espion = (): never =>
  new Proxy(function () {}, { get: (_c, p) => (p === "then" ? undefined : espion()), apply: () => { appels++; return undefined; } }) as never;
const exigerEquipe = async (requete: { headers: Record<string, unknown> }) => {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(requete.headers["cookie"] ?? ""))?.[1] ?? "";
  const session = Object.hasOwn(SESSIONS, sid) ? SESSIONS[sid] : undefined;
  if (!session || !ROLES_EQUIPE.has(session.role)) throw new ErreurApi("action_interdite", "Action interdite.");
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

async function jouer(methode: "GET" | "POST", url: string, id: string, sid?: string) {
  const avant = appels;
  const r = await appli.inject({ method: methode, url, headers: sid ? { cookie: `sid=${sid}` } : {}, payload: methode === "POST" ? { motif: "essai", tenantId: id } : undefined });
  const corps = r.json() as { erreur?: { id_trace?: string } };
  if (corps.erreur) delete corps.erreur.id_trace;
  return { statut: r.statusCode, corps, appels: appels - avant };
}
// `chemin` est le chemin déclaré ; l'identifiant, le paramètre de recherche et le corps portent d'abord la ressource de B, puis une ressource absente : les deux requêtes diffèrent toujours.
async function verifier(methode: "GET" | "POST", chemin: string) {
  const vers = (id: string) => `${chemin.replace(":tenantId", id).replace(":idGel", GEL).replace(":id", id)}${chemin.includes(":id") || chemin.includes(":tenantId") ? "" : `?tenantId=${id}`}`;
  expect(vers(B)).not.toBe(vers(ABSENT));
  const autreClient = await jouer(methode, vers(B), B, "sid-client-a");
  const absente = await jouer(methode, vers(ABSENT), ABSENT, "sid-client-a");
  const sansSession = await jouer(methode, vers(B), B);
  expect(autreClient).toEqual(absente);
  expect(sansSession).toEqual(absente);
  // Témoin : la même requête, avec une session d'équipe, passe le contrôle d'équipe (le refus vient bien de la session).
  expect((await jouer(methode, vers(B), B, "sid-equipe")).statut).not.toBe(403);
  return { statut: autreClient.statut, appels: autreClient.appels, corps: autreClient.corps };
}
const REFUS = { statut: 403, appels: 0, corps: { erreur: { code: "action_interdite", message: "Action interdite." } } };

describe("mauvais client : routes de l'équipe", () => {
  it("[C-536] @isolation GET /api/console/v1/clients/:id/gel", async () => expect(await verifier("GET", "/api/console/v1/clients/:id/gel")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/gel", async () => expect(await verifier("POST", "/api/console/v1/clients/:id/gel")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/gel/:idGel/lever", async () => expect(await verifier("POST", "/api/console/v1/clients/:id/gel/:idGel/lever")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/a-trancher/:id/appliquer", async () => expect(await verifier("POST", "/api/console/v1/a-trancher/:id/appliquer")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/a-trancher/:id/ecarter", async () => expect(await verifier("POST", "/api/console/v1/a-trancher/:id/ecarter")).toEqual(REFUS));
  it("[C-536] @isolation GET /api/console/v1/canaux/echecs", async () => expect(await verifier("GET", "/api/console/v1/canaux/echecs")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/canaux/echecs/:tenantId/:id/renvoyer", async () => expect(await verifier("POST", "/api/console/v1/canaux/echecs/:tenantId/:id/renvoyer")).toEqual(REFUS));
  it("[C-536] @isolation GET /equipe/journal", async () => expect(await verifier("GET", "/equipe/journal?entite=client&entiteId=:id")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/journal/:id/annuler", async () => expect(await verifier("POST", "/api/console/v1/journal/:id/annuler")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/clients/:id/base/reprendre", async () => expect(await verifier("POST", "/api/console/v1/clients/:id/base/reprendre")).toEqual(REFUS));
  it("[C-536] @isolation GET /api/console/v1/instances/:id/reglages/versions", async () => expect(await verifier("GET", "/api/console/v1/instances/:id/reglages/versions")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/instances/:id/reglages", async () => expect(await verifier("POST", "/api/console/v1/instances/:id/reglages")).toEqual(REFUS));
  it("[C-536] @isolation POST /api/console/v1/instances/:id/reglages/revenir", async () => expect(await verifier("POST", "/api/console/v1/instances/:id/reglages/revenir")).toEqual(REFUS));
});
