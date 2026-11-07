import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compterEnregistrements, EXEMPTEES, listerRoutes, routesSansTest, testsDeclares } from "./liste-routes.js";

// Garde « mauvais client » (C-536). Un nom de test déclare une route par « [C-536] @isolation <MÉTHODE> <chemin> » dans tests/mauvais-client/*.test.ts (projet « tests/mauvais-client », exécuté par le job « tests »).
// La déclaration doit être le titre d'un vrai it()/test() ni sauté ni à écrire, dont le corps contient au moins un expect(.
const racine = fileURLToPath(new URL("../", import.meta.url));
const lire = (dossier: string, garde: (f: string) => boolean) =>
  readdirSync(`${racine}${dossier}`).filter(garde).map((f) => readFileSync(`${racine}${dossier}/${f}`, "utf8"));
// Tous les fichiers .ts de l'API hors tests, à tout niveau (serveur.ts compris).
const sourcesApi = (dossier = "apps/api/src"): string[] =>
  readdirSync(`${racine}${dossier}`, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourcesApi(`${dossier}/${e.name}`) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [readFileSync(`${racine}${dossier}/${e.name}`, "utf8")] : []);

describe("garde des routes « mauvais client »", () => {
  it("[C-536] la garde échoue pour une route sans test mauvais client", () => {
    const routes = [{ methode: "GET", chemin: "/api/v1/nouvelle/:id" }, { methode: "GET", chemin: "/sante" }];
    const erreurs = routesSansTest(routes, testsDeclares(["it(\"[C-536] @isolation POST /api/v1/autre\", () => { expect(1).toBe(1); });"]));
    expect(erreurs).toEqual(["GET /api/v1/nouvelle/:id : aucun test « [C-536] @isolation GET /api/v1/nouvelle/:id »"]);
    // Un test déclaré pour la route la fait passer ; l'exemption doit être motivée.
    expect(routesSansTest(routes, testsDeclares(["it(\"[C-536] @isolation GET /api/v1/nouvelle/:id\", () => { expect(1).toBe(1); });"]))).toEqual([]);
  });

  it("[C-536] chaque route de l'API a un test mauvais client déclaré ou une exemption motivée", async () => {
    const declares = testsDeclares(lire("tests/mauvais-client", (f) => f.endsWith(".test.ts")));
    expect(routesSansTest(await listerRoutes(), declares)).toEqual([]);
    expect(declares.size).toBeGreaterThan(0);
  });

  it("[C-536] la liste fermée des exemptions a une raison et ne vise que des routes qui existent", async () => {
    const routes = new Set((await listerRoutes()).map((r) => `${r.methode} ${r.chemin}`));
    for (const [route, raison] of Object.entries(EXEMPTEES)) {
      expect(routes.has(route), route).toBe(true);
      expect(raison.trim().length, route).toBeGreaterThan(10);
    }
    expect(Object.keys(EXEMPTEES).sort()).toEqual(["GET /sante", "GET /sante/pret", "POST /api/catalogue/v1/versions", "POST /api/catalogue/v1/versions/:id/passages", "POST /api/catalogue/v1/versions/:id/preuves", "POST /api/console/v1/entree", "POST /api/crm/v1/evenements", "POST /api/hub/v1/faits"]);
  });

  it("[C-536] la garde refuse une déclaration en commentaire, sautée, à écrire ou sans assertion", () => {
    const titre = "[C-536] @isolation GET /api/v1/x";
    // Mots assemblés ici pour que le compteur de tests (C-538) ne prenne pas ces exemples pour de vrais tests sautés.
    const SAUT = ["sk", "ip"].join("");
    const A_FAIRE = ["to", "do"].join("");
    const refusees = [
      `// ${titre}`,
      `/* it("${titre}", () => { expect(1).toBe(1); }); */`,
      `const t = "${titre}";`,
      `it.${SAUT}("${titre}", () => { expect(1).toBe(1); });`,
      `test.${SAUT}("${titre}", () => { expect(1).toBe(1); });`,
      `it.${A_FAIRE}("${titre}");`,
      `describe.${SAUT}("x", () => { it("${titre}", () => { expect(1).toBe(1); }); });`,
      `it("${titre}", () => {});`,
      `it("${titre}", async () => { await Promise.resolve(); });`,
      `it("${titre}");`,
    ];
    for (const texte of refusees) expect([...testsDeclares([texte])], texte).toEqual([]);
    const acceptees = [`it("${titre}", () => { expect(1).toBe(1); });`, `test("${titre}", async () => expect(await Promise.resolve(1)).toBe(1));`];
    for (const texte of acceptees) expect([...testsDeclares([texte])], texte).toEqual(["GET /api/v1/x"]);
  });

  it("[C-536] le comptage du code source voit toutes les formes d'enregistrement d'une route", () => {
    const formes = [
      "serveur.get(\"/a\", async () => 1);",
      "appli.post<{ Params: { id: string } }>(`/b/${x}`, o, async () => 1);",
      "app.get(\"/c\", async () => 1);",
      "fastify.post(\"/d\", async () => 1);",
      "s.delete(chemin, async () => 1);",
      "instance.put(\"/e\", async () => 1);",
      "serveur.route({ method: \"GET\", url: \"/f\", handler });",
    ];
    for (const forme of formes) expect(compterEnregistrements(forme), forme).toBe(1);
    expect(compterEnregistrements(formes.join("\n"))).toBe(formes.length);
    expect(compterEnregistrements("const m = new Map(); m.get(cle); deja.get(v); corps.delete(x);")).toBe(0);
  });

  it("[C-536] toute route enregistrée dans le code de l'API figure dans la liste des routes", async () => {
    // Une route ajoutée dans apps/api/src (routes/, serveur.ts, ailleurs) sans passer par scripts/liste-routes.ts fait échouer la garde.
    const enregistrees = sourcesApi().reduce((n, source) => n + compterEnregistrements(source), 0);
    expect((await listerRoutes()).length).toBe(enregistrees);
  });
});
