import { fastifyVide as Fastify } from "../../scripts/liste-routes.js";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { CHEMIN_CONSOLE, CHEMIN_EFFACEMENT, gestionnairesFinDeContrat } from "../../apps/api/src/routes/fin-de-contrat.js";

// Fin de contrat : la session de l'équipe est celle de A ; quoi que la requête désigne pour B (URL, corps, en-tête), rien n'est lancé pour B (C-536). Ports en mémoire.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("mauvais client : fin de contrat", () => {
  it("[C-536] @isolation POST /api/console/v1/clients/:id/fin-de-contrat et /demande-effacement pour un autre client", async () => {
    const appels: string[] = [];
    const app = Fastify();
    brancherErreurs(app);
    const g = gestionnairesFinDeContrat({
      session: async () => ({ acteur: "equipe:u1", role: "administrateur", clientActifId: A, reauthentifie: true }),
      lancer: async (x) => { appels.push(x.tenantId); return "lancee" as const; },
      maintenant: () => new Date("2026-11-06T09:00:00Z"),
      demanderEffacement: async (t) => void appels.push(t),
      confirmer: async () => false,
    });
    app.post(CHEMIN_CONSOLE, g.lancer);
    app.post(CHEMIN_EFFACEMENT, g.demandeEffacement);
    const reponses = await Promise.all([
      app.inject({ method: "POST", url: CHEMIN_CONSOLE.replace(":id", B), payload: { dateFin: "2027-01-10" }, headers: { "x-tenant": A } }),
      app.inject({ method: "POST", url: CHEMIN_EFFACEMENT.replace(":id", B), payload: { ecritReference: "objet/e1" }, headers: { "x-tenant": A } }),
    ]);
    expect(reponses.map((r) => r.statusCode)).toEqual([403, 403]);
    expect(appels).toEqual([]);
    expect((await app.inject({ method: "POST", url: CHEMIN_CONSOLE.replace(":id", A), payload: { dateFin: "2027-01-10" } })).statusCode).toBe(202);
    expect(appels).toEqual([A]);
  });
});
