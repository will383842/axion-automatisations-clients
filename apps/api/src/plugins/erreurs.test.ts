import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { demarrerFauxSentry } from "../../../../packages/observabilite/test/faux-sentry.ts";
import { demarrerSentry } from "../../../../packages/observabilite/src/sentry.ts";
import { STATUT_PAR_CODE } from "../../../../packages/contrats/src/commun/erreurs.js";
import { construireServeur } from "../serveur.js";
import { brancherErreurs, ErreurApi } from "./erreurs.js";

describe("format d'erreur commun", () => {
  it("[LOT1-api] une erreur sort au format commun avec id_trace", async () => {
    const serveur = construireServeur();
    serveur.get("/essai", async () => {
      throw new ErreurApi("action_interdite", "Accès refusé.");
    });
    const reponse = await serveur.inject({ method: "GET", url: "/essai" });
    expect(reponse.statusCode).toBe(STATUT_PAR_CODE.action_interdite);
    const { erreur } = reponse.json();
    expect(erreur).toMatchObject({ code: "action_interdite", message: "Accès refusé." });
    expect(typeof erreur.id_trace).toBe("string");
    await serveur.close();
  });

  it("[LOT1-api] attaque : une erreur inattendue ne montre ni son message ni sa pile", async () => {
    const serveur = construireServeur();
    serveur.get("/essai", async () => {
      throw new Error("mot de passe=secret-de-test à /srv/app/fichier.ts");
    });
    const reponse = await serveur.inject({ method: "GET", url: "/essai" });
    expect(reponse.statusCode).toBe(STATUT_PAR_CODE.erreur_interne);
    expect(reponse.body).not.toMatch(/secret-de-test|fichier\.ts|at /);
    expect(reponse.json().erreur.code).toBe("erreur_interne");
    await serveur.close();
  });

  it("[LOT1-api] attaque : on peut jeter autre chose qu'une Error sans casser le format", async () => {
    const serveur = construireServeur();
    serveur.get("/essai", async () => {
      throw "texte brut";
    });
    const reponse = await serveur.inject({ method: "GET", url: "/essai" });
    expect(reponse.statusCode).toBe(500);
    expect(reponse.json().erreur.code).toBe("erreur_interne");
    await serveur.close();
  });

  it("[LOT1-api] attaque : l'id_trace est choisi par le serveur, jamais par l'en-tête du client", async () => {
    const serveur = construireServeur();
    const a = await serveur.inject({ method: "GET", url: "/absente", headers: { "x-request-id": "pirate" } });
    const b = await serveur.inject({ method: "GET", url: "/absente" });
    expect(a.json().erreur.id_trace).not.toBe("pirate");
    expect(a.json().erreur.id_trace).not.toBe(b.json().erreur.id_trace);
    await serveur.close();
  });

  it("[LOT1-api] une route inconnue, un corps invalide et un JSON cassé sortent au format commun", async () => {
    const serveur = construireServeur();
    serveur.post("/essai", { schema: { body: { type: "object", required: ["a"], properties: { a: { type: "string" } } } } }, async () => ({}));
    const inconnue = await serveur.inject({ method: "GET", url: "/absente" });
    expect(inconnue.statusCode).toBe(STATUT_PAR_CODE.introuvable);
    expect(inconnue.json().erreur.code).toBe("introuvable");
    const invalide = await serveur.inject({ method: "POST", url: "/essai", payload: { b: 1 } });
    expect(invalide.statusCode).toBe(STATUT_PAR_CODE.schema_invalide);
    expect(invalide.json().erreur.code).toBe("schema_invalide");
    const casse = await serveur.inject({ method: "POST", url: "/essai", headers: { "content-type": "application/json" }, payload: "{" });
    expect(casse.json().erreur.code).toBe("schema_invalide");
    await serveur.close();
  });
});

describe("erreurs : signalement des erreurs internes", () => {
  it("[C-025] une erreur 4xx de l'API n'est jamais envoyée ; une erreur interne l'est, sans corps de requête", async () => {
    const faux = await demarrerFauxSentry();
    const sentry = demarrerSentry({ dsn: `https://cle${"@"}o1.ingest.de.sentry.io/1`, application: "api", version: "1", fetch: faux.fetch });
    const serveur = Fastify();
    brancherErreurs(serveur, { signaler: (e, route) => sentry.capturer(e, route) });
    serveur.post("/essai-4xx", async () => { throw new ErreurApi("action_interdite", "Accès refusé."); });
    serveur.post("/essai-5xx", async () => { throw new Error("panne interne"); });
    const corps = { note: "contenu-de-requete-unique-9f8e7d" };
    expect((await serveur.inject({ method: "POST", url: "/essai-4xx", payload: corps })).statusCode).toBe(STATUT_PAR_CODE.action_interdite);
    await sentry.vider(2000);
    expect(faux.corps).toHaveLength(0);
    expect((await serveur.inject({ method: "POST", url: "/essai-5xx?jeton=abc", payload: corps })).statusCode).toBe(STATUT_PAR_CODE.erreur_interne);
    await sentry.vider(2000);
    expect(faux.corps).toHaveLength(1);
    expect(faux.corps[0]).toContain("panne interne");
    expect(faux.corps[0]).not.toContain("contenu-de-requete-unique");
    expect(faux.corps[0]).not.toContain("jeton=abc");
    await serveur.close();
    await faux.fermer();
  });
});
