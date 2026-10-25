import { describe, expect, it } from "vitest";
import { STATUT_PAR_CODE } from "../../../../packages/contrats/src/commun/erreurs.js";
import { construireServeur } from "../serveur.js";
import { ErreurApi } from "./erreurs.js";

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
      throw "texte brut"; // eslint-disable-line @typescript-eslint/only-throw-error
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
