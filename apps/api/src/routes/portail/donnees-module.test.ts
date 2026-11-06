import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { fastifyVide } from "../../../../../scripts/liste-routes.js";
import { routeDonneesModule } from "./donnees-module.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const INST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function monter(ouvert = true) {
  const appels: unknown[][] = [];
  const appli = fastifyVide();
  brancherErreurs(appli);
  routeDonneesModule(appli, { ouvert, session: async () => ({ tenantId: A, role: "client", acteur: "u1", etablissements: [] }), lire: async (...a) => { appels.push(a); return [{ total: 1 }]; } });
  return { appli, appels };
}

describe("route des requêtes déclarées", () => {
  it("[C-624] @isolation POST /api/portail/v1/automatisations/:instance/donnees/:nom ignore tout client désigné par l'adresse, un en-tête, un cookie ou le corps", async () => {
    const { appli, appels } = monter();
    const url = `/api/portail/v1/automatisations/${INST}/donnees/compte`;
    const r = await appli.inject({ method: "POST", url: `${url}?tenantId=${B}`, headers: { "x-tenant": B, cookie: `tenant=${B}` }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ lignes: [{ total: 1 }] });
    expect(appels[0]![0]).toMatchObject({ tenantId: A });
    expect(JSON.stringify(appels)).not.toContain(B);
    await appli.close();
  });

  it("[C-624] la route est fermée par défaut et refuse un nom ou une instance mal formés", async () => {
    const f = monter(false);
    expect((await f.appli.inject({ method: "POST", url: `/api/portail/v1/automatisations/${INST}/donnees/compte`, payload: {} })).statusCode).toBe(503);
    const o = monter();
    expect((await o.appli.inject({ method: "POST", url: `/api/portail/v1/automatisations/${INST}/donnees/Mauvais_Nom`, payload: {} })).statusCode).toBe(400);
    expect((await o.appli.inject({ method: "POST", url: `/api/portail/v1/automatisations/pas-uuid/donnees/compte`, payload: {} })).statusCode).toBe(400);
    expect(o.appels).toEqual([]);
  });

  it("[C-624] aucune route d'écriture n'existe (actions refusé)", async () => {
    const { appli } = monter();
    expect((await appli.inject({ method: "POST", url: `/api/portail/v1/automatisations/${INST}/actions/ecrire`, payload: {} })).statusCode).toBe(404);
  });
});
