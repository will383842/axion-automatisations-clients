import { describe, expect, it } from "vitest";
import { ACTIONS, ACTION_PAR_ROUTE } from "../apps/api/src/droits/matrice.js";
import { EXEMPTEES_DROITS, actionsInvalides, routesDeLaConsole, routesSansAction } from "./garde-droits.js";
import { listerRoutes } from "./liste-routes.js";

describe("garde des droits (T3-06)", () => {
  it("[LOT3-droits] la garde échoue pour une route sans action déclarée", () => {
    const routes = [{ methode: "GET", chemin: "/api/console/v1/nouvelle" }, { methode: "GET", chemin: "/sante" }];
    expect(routesSansAction(routesDeLaConsole(routes), {})).toEqual(["GET /api/console/v1/nouvelle : aucune action déclarée dans la matrice"]);
    expect(routesSansAction(routesDeLaConsole(routes), { "GET /api/console/v1/nouvelle": "lire" })).toEqual([]);
  });

  it("[LOT3-droits] la garde refuse une action absente de la liste fermée et une déclaration pour une route qui n'existe plus", () => {
    expect(actionsInvalides({ "GET /api/console/v1/x": "tout_faire" }, [])).toEqual([
      "GET /api/console/v1/x : action « tout_faire » hors de la liste fermée",
      "GET /api/console/v1/x : route déclarée mais absente de l'API",
    ]);
  });

  it("[LOT3-droits] chaque route de la console déclare son action dans la matrice", async () => {
    const routes = await listerRoutes();
    expect(routesSansAction(routesDeLaConsole(routes), ACTION_PAR_ROUTE)).toEqual([]);
    expect(actionsInvalides(ACTION_PAR_ROUTE, routes.map((r) => `${r.methode} ${r.chemin}`))).toEqual([]);
    for (const [route, raison] of Object.entries(EXEMPTEES_DROITS)) expect(raison.trim().length, route).toBeGreaterThan(10);
    expect(ACTIONS.length).toBeGreaterThan(10);
  });
});
