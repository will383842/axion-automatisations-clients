import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXEMPTEES, listerRoutes, routesSansTest, testsDeclares } from "./liste-routes.js";

// Garde « mauvais client » (C-536). Un nom de test déclare une route par « [C-536] @isolation <MÉTHODE> <chemin> » dans tests/mauvais-client/*.int.test.ts.
const racine = fileURLToPath(new URL("../", import.meta.url));
const lire = (dossier: string, garde: (f: string) => boolean) =>
  readdirSync(`${racine}${dossier}`).filter(garde).map((f) => readFileSync(`${racine}${dossier}/${f}`, "utf8"));

describe("garde des routes « mauvais client »", () => {
  it("[C-536] la garde échoue pour une route sans test mauvais client", () => {
    const routes = [{ methode: "GET", chemin: "/api/v1/nouvelle/:id" }, { methode: "GET", chemin: "/sante" }];
    const erreurs = routesSansTest(routes, testsDeclares(["it(\"[C-536] @isolation POST /api/v1/autre\", () => {})"]));
    expect(erreurs).toEqual(["GET /api/v1/nouvelle/:id : aucun test « [C-536] @isolation GET /api/v1/nouvelle/:id »"]);
    // Un test déclaré pour la route la fait passer ; l'exemption doit être motivée.
    expect(routesSansTest(routes, testsDeclares(["[C-536] @isolation GET /api/v1/nouvelle/:id"]))).toEqual([]);
  });

  it("[C-536] chaque route de l'API a un test mauvais client déclaré ou une exemption motivée", async () => {
    const declares = testsDeclares(lire("tests/mauvais-client", (f) => f.endsWith(".int.test.ts")));
    expect(routesSansTest(await listerRoutes(), declares)).toEqual([]);
    expect(declares.size).toBeGreaterThan(0);
  });

  it("[C-536] la liste fermée des exemptions a une raison et ne vise que des routes qui existent", async () => {
    const routes = new Set((await listerRoutes()).map((r) => `${r.methode} ${r.chemin}`));
    for (const [route, raison] of Object.entries(EXEMPTEES)) {
      expect(routes.has(route), route).toBe(true);
      expect(raison.trim().length, route).toBeGreaterThan(10);
    }
    expect(Object.keys(EXEMPTEES).sort()).toEqual(["GET /sante", "GET /sante/pret", "POST /api/console/v1/entree", "POST /api/crm/v1/evenements", "POST /api/hub/v1/faits"]);
  });

  it("[C-536] toute route enregistrée dans le code de l'API figure dans la liste des routes", async () => {
    // Une route ajoutée dans routes/ sans passer par scripts/liste-routes.ts fait échouer la garde.
    const source = lire("apps/api/src/routes", (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).join("\n");
    const enregistrees = [...source.matchAll(/\b(?:serveur|appli|s)\.(?:get|post|put|patch|delete)(?:<[^(]*?>)?\(/g)].length;
    expect((await listerRoutes()).length).toBe(enregistrees);
  });
});
