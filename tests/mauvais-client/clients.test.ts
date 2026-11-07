import { describe, expect, it } from "vitest";
import { fastifyVide } from "../../scripts/liste-routes.js";
import { depotVuesEnMemoire } from "../../apps/api/src/clients/liste.js";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeClients } from "../../apps/api/src/routes/clients/liste.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ligne = (n: number) => ({ id: id(n), nom: `Atelier Bertin ${n}`, formule: "abonnement" as const, sante: "bon" as const, statut: "client" as const, apporteur: null, modeleIa: null, metier: null });
// Un second administrateur limité au client 1 : le client 2 n'apparaît dans aucune réponse de la liste, des vues ni de l'export.
function app() {
  const a = fastifyVide();
  brancherErreurs(a);
  routeClients(a, {
    ouvert: () => true, exigerEquipe: (async () => undefined) as never,
    membre: async () => ({ sujet: "second-test", role: "second_administrateur" as const, actif: true, portee: { clients: [id(1)], automatisations: [] } }),
    clients: { toutes: async () => [ligne(1), ligne(2)] }, vues: depotVuesEnMemoire(), tracerExport: async () => undefined,
  });
  return a;
}
const B = "/api/console/v1/clients";
describe("clients : mauvais client", () => {
  it("[C-536] @isolation GET /api/console/v1/clients", async () => {
    const r = await app().inject({ url: B });
    expect(r.body).not.toContain("Atelier Bertin 2");
    expect(r.json().lignes).toHaveLength(1);
  });
  it("[C-536] @isolation POST /api/console/v1/clients/export", async () => {
    const r = await app().inject({ method: "POST", url: `${B}/export`, payload: {} });
    expect(r.body).not.toContain("Atelier Bertin 2");
  });
  it("[C-536] @isolation GET /api/console/v1/clients/vues", async () => {
    const r = await app().inject({ url: `${B}/vues` });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("Atelier Bertin 2");
  });
  it("[C-536] @isolation POST /api/console/v1/clients/vues", async () => {
    const a = app();
    const cree = await a.inject({ method: "POST", url: `${B}/vues`, payload: { nom: "Ma vue", filtres: {} } });
    expect(cree.statusCode).toBe(201);
    expect((await a.inject({ url: `${B}?vue=${id(9)}` })).statusCode).toBe(404);
  });
});
