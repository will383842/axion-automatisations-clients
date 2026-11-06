import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeDonneesModule } from "../../apps/api/src/routes/portail/donnees-module.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const INST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("mauvais client : requêtes déclarées des modules", () => {
  it("[C-536] @isolation POST /api/portail/v1/automatisations/:instance/donnees/:nom ignore tout client désigné par l'adresse, un en-tête, un cookie ou le corps", async () => {
    const { appli, appels } = (() => { const appels: unknown[][] = []; const appli = fastifyVide(); brancherErreurs(appli); routeDonneesModule(appli, { ouvert: true, session: async () => ({ tenantId: A, role: "client", acteur: "u1", etablissements: [] }), lire: async (...a) => { appels.push(a); return [{ total: 1 }]; } }); return { appli, appels }; })();
    const url = `/api/portail/v1/automatisations/${INST}/donnees/compte`;
    const r = await appli.inject({ method: "POST", url: `${url}?tenantId=${B}`, headers: { "x-tenant": B, cookie: `tenant=${B}` }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ lignes: [{ total: 1 }] });
    expect(appels[0]![0]).toMatchObject({ tenantId: A });
    expect(JSON.stringify(appels)).not.toContain(B);
    await appli.close();
  });

});
