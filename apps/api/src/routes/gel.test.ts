import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { envoisServiceEnMemoire } from "../envois/service.js";
import { depotGelsEnMemoire, type SessionEquipe } from "../gel/gel.js";
import { routeGel } from "./gel.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "33333333-3333-4333-8333-333333333333";
function serveur(session: SessionEquipe = { acteur: "will383842", role: "administrateur", organisationId: CLIENT, reauthentifie: true }) {
  const app = Fastify();
  brancherErreurs(app);
  const depot = depotGelsEnMemoire();
  const envois = envoisServiceEnMemoire();
  let n = 0;
  const passe = async () => undefined;
  routeGel(app, { exigerEquipe: passe as never, exigerReauthentification: passe as never, session: async () => session, gel: { depot, envois, maintenant: () => new Date("2026-11-02T10:00:00Z"), nouvelId: () => `00000000-0000-4000-8000-00000000000${++n}` } });
  return { app, depot, envois };
}
const base = (c = CLIENT) => `/api/console/v1/clients/${c}/gel`;

describe("routes du gel pour litige", () => {
  it("[C-609] POST pose, GET liste, POST lever lève ; la ligne reste dans l'historique", async () => {
    const { app, envois } = serveur();
    const pose = await app.inject({ method: "POST", url: base(), payload: { motif: "litige" } });
    expect(pose.statusCode).toBe(201);
    const { id } = pose.json();
    expect((await app.inject({ method: "GET", url: base() })).json().gels).toHaveLength(1);
    const leve = await app.inject({ method: "POST", url: `${base()}/${id}/lever`, payload: { motif: "réglé" } });
    expect(leve.statusCode).toBe(200);
    expect(leve.json()).toMatchObject({ id, levee_le: "2026-11-02T10:00:00.000Z", leve_par: "will383842" });
    expect((await app.inject({ method: "GET", url: base() })).json().gels).toHaveLength(1);
    expect(envois.deposes).toHaveLength(2);
  });

  it("[C-609] un client d'URL différent de l'organisation de la session, un rôle autre qu'administrateur, une réauthentification manquante : refus, rien n'est écrit", async () => {
    const autre = await serveur().app.inject({ method: "POST", url: base(AUTRE), payload: { motif: "m" } });
    expect(autre.statusCode).toBe(403);
    const lecture = await serveur().app.inject({ method: "GET", url: base(AUTRE) });
    expect(lecture.statusCode).toBe(403);
    const role = serveur({ acteur: "a", role: "support", organisationId: CLIENT, reauthentifie: true });
    expect((await role.app.inject({ method: "POST", url: base(), payload: { motif: "m" } })).statusCode).toBe(403);
    const reauth = serveur({ acteur: "a", role: "administrateur", organisationId: CLIENT, reauthentifie: false });
    expect((await reauth.app.inject({ method: "POST", url: base(), payload: { motif: "m" } })).statusCode).toBe(401);
    expect(await reauth.depot.lister(CLIENT)).toEqual([]);
  });

  it("[C-609] motif vide, date future, champ en trop ou acteur dans le corps : requête invalide", async () => {
    const { app, depot } = serveur();
    for (const payload of [{ motif: "" }, { motif: "m", posee_le: "2027-01-01T00:00:00Z" }, { motif: "m", pose_par: "x" }, {}, { motif: "m", posee_le: "pas une date" }]) {
      expect((await app.inject({ method: "POST", url: base(), payload })).statusCode).toBe(400);
    }
    expect(await depot.lister(CLIENT)).toEqual([]);
  });
});
