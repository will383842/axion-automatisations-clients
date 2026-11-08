import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../plugins/erreurs.js";
import { fastifyVide } from "../../../../../scripts/liste-routes.js";
import { routeListeCatalogue, type DepsListeCatalogue } from "./liste.js";

// Routes de la liste du catalogue (T3-40a) : fermées par défaut, droit « lire » pour l'équipe, synonymes réservés au dirigeant.
const AUTO = "00000000-0000-4000-8000-000000000001";
let role = "dirigeant";
const traces: string[] = [];
const appels: string[] = [];
const service = {
  lister: async () => { appels.push("lister"); return { automatisations: [], curseur_suivant: null }; },
  rechercher: async () => { appels.push("rechercher"); return { automatisations: [] }; },
  doublons: async () => { appels.push("doublons"); return { bloquant: false, proches: [] }; },
  ecrireSynonyme: async () => { appels.push("synonyme"); return { mot: "relance", equivalent: "rappel" }; },
};
const deps = (ouvert: boolean): DepsListeCatalogue => ({
  ouvert,
  exigerEquipe: (async () => undefined) as never,
  droits: { membre: async () => ({ sujet: "m1", role: role as never, actif: true, portee: { clients: ["*"], automatisations: [] } }), absenceOuverte: async () => false, tracer: async (e) => { traces.push(e.action); } },
  acteur: async () => "equipe-essai",
  service: service as never,
});
async function construire(ouvert: boolean) {
  const a = fastifyVide();
  brancherErreurs(a);
  routeListeCatalogue(a, deps(ouvert));
  await a.ready();
  return a;
}
let ouverte: Awaited<ReturnType<typeof construire>>;
let fermee: Awaited<ReturnType<typeof construire>>;
beforeAll(async () => { ouverte = await construire(true); fermee = await construire(false); });

describe("routes du catalogue", () => {
  it("[B-532] les routes sont fermées par défaut (503) et n'appellent aucun service", async () => {
    appels.length = 0;
    for (const url of ["/api/console/v1/catalogue", "/api/console/v1/catalogue/recherche?q=ab", "/api/console/v1/catalogue/doublons?nom=ab"]) {
      expect((await fermee.inject({ method: "GET", url })).statusCode).toBe(503);
    }
    expect(appels).toEqual([]);
  });
  it("[B-532] la liste, la recherche et les doublons répondent à l'équipe", async () => {
    role = "second_administrateur";
    expect((await ouverte.inject({ method: "GET", url: "/api/console/v1/catalogue" })).statusCode).not.toBe(503);
    role = "dirigeant";
    for (const url of ["/api/console/v1/catalogue", "/api/console/v1/catalogue/recherche?q=ab", "/api/console/v1/catalogue/doublons?nom=ab"]) {
      expect((await ouverte.inject({ method: "GET", url })).statusCode).toBe(200);
    }
  });
  it("[B-533] un membre non dirigeant ne peut pas modifier les synonymes, et le refus est tracé", async () => {
    role = "second_administrateur";
    appels.length = 0;
    const r = await ouverte.inject({ method: "POST", url: "/api/console/v1/catalogue/synonymes", payload: { mot: "relance", equivalent: "rappel" } });
    expect(r.statusCode).toBe(403);
    expect(appels).toEqual([]);
    expect(traces).toContain("publier_catalogue");
    role = "dirigeant";
    const ok = await ouverte.inject({ method: "POST", url: "/api/console/v1/catalogue/synonymes", payload: { mot: "relance", equivalent: "rappel" } });
    expect(ok.statusCode).toBe(201);
    expect(ErreurApi).toBeDefined();
  });
});
