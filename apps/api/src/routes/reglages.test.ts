import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeAnnulation } from "./journal.js";
import { routeReglages, type Contexte } from "./reglages.js";

// Routes des versions de réglages et de l'annulation : le client actif vient de la session, jamais d'un paramètre.
const INSTANCE = "22222222-2222-4222-8222-222222222222";
const SESSION: Contexte = { tenantId: "11111111-1111-4111-8111-111111111111", acteur: "agent-essai" };
const v = { id: "a", numero: 1, donnees: {}, auteur: "agent-essai", motif: "m", active: true };
function serveur(equipe = true, rejeu = false) {
  const appels: unknown[][] = [];
  const app = Fastify();
  brancherErreurs(app);
  const exigerEquipe = async (_q: unknown, rep: { status(n: number): { send(b: unknown): unknown } }) => { if (!equipe) return rep.status(403).send({ erreur: { code: "action_interdite" } }); };
  const contexte = async () => SESSION;
  routeReglages(app, {
    exigerEquipe: exigerEquipe as never, contexte,
    async historique(c, i) { appels.push(["historique", c, i]); return [v]; },
    async modifier(c, i, d, m) { appels.push(["modifier", c, i, d, m]); return v; },
    async revenir(c, i, n, m) { appels.push(["revenir", c, i, n, m]); return { ...v, cree: !rejeu }; },
  });
  routeAnnulation(app, { exigerEquipe: exigerEquipe as never, contexte, async annuler(c, id) { appels.push(["annuler", c, id]); return { entite: "configurations", entite_id: "a" }; } });
  return { app, appels };
}

describe("routes des versions de réglages", () => {
  it("[A-175] les quatre routes appellent le service avec le client et l'auteur de la session", async () => {
    const { app, appels } = serveur();
    const base = `/api/console/v1/instances/${INSTANCE}/reglages`;
    expect((await app.inject({ method: "GET", url: `${base}/versions` })).json()).toEqual({ versions: [v] });
    expect((await app.inject({ method: "POST", url: base, payload: { donnees: { a: 1 }, motif: "essai" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${base}/revenir`, payload: { numero: 2 } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/console/v1/journal/42/annuler" })).statusCode).toBe(200);
    expect(appels.map((a) => a[0])).toEqual(["historique", "modifier", "revenir", "annuler"]);
    expect(appels.every((a) => a[1] === SESSION)).toBe(true);
  });

  it("[A-176] un retour arrière sans effet répond 200 avec cree:false, un retour réel répond 201 avec cree:true", async () => {
    const url = `/api/console/v1/instances/${INSTANCE}/reglages/revenir`;
    const sans = await serveur(true, true).app.inject({ method: "POST", url, payload: { numero: 2 } });
    expect(sans.statusCode).toBe(200);
    expect(sans.json()).toMatchObject({ cree: false });
    const reel = await serveur().app.inject({ method: "POST", url, payload: { numero: 2 } });
    expect(reel.statusCode).toBe(201);
    expect(reel.json()).toMatchObject({ cree: true });
  });

  it("[A-119] un client ou un auteur fourni dans le corps est refusé, rien n'est écrit", async () => {
    const { app, appels } = serveur();
    const base = `/api/console/v1/instances/${INSTANCE}/reglages`;
    for (const payload of [{ donnees: {}, motif: "m", tenantId: "x" }, { donnees: {}, motif: "m", auteur: "x" }, { donnees: {} }, { donnees: [], motif: "m" }]) {
      expect((await app.inject({ method: "POST", url: base, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/api/console/v1/instances/pas-un-uuid/reglages", payload: { donnees: {}, motif: "m" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/console/v1/journal/abc/annuler" })).statusCode).toBe(400);
    expect(appels).toEqual([]);
  });

  it("[A-175] sans le contrôle d'accès de l'équipe, rien n'est appelé", async () => {
    const { app, appels } = serveur(false);
    expect((await app.inject({ method: "POST", url: `/api/console/v1/instances/${INSTANCE}/reglages/revenir`, payload: { numero: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/console/v1/journal/1/annuler" })).statusCode).toBe(403);
    expect(appels).toEqual([]);
  });
});
