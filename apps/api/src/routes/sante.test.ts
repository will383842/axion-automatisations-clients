import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATUT_PAR_CODE } from "../../../../packages/contrats/src/commun/erreurs.js";
import { construireServeur } from "../serveur.js";

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const baseFausse = (requete: () => Promise<{ rows: unknown[] }>) => ({ query: requete, end: async () => undefined, connect: async () => ({}) }) as never;

describe("route /sante", () => {
  it("[C-397] essai : GET /sante répond 200 et la version", async () => {
    const serveur = construireServeur();
    const reponse = await serveur.inject({ method: "GET", url: "/sante" });
    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toEqual({ etat: "ok", version });
    await serveur.close();
  });

  it("[A-087] l'API démarre et /sante répond 200 quand le Hub et le CRM sont injoignables", async () => {
    const serveur = construireServeur({
      config: { env: "test", port: 0, hubUrl: "http://hub.test:9", crmUrl: "http://crm.test:9" },
    });
    const reponse = await serveur.inject({ method: "GET", url: "/sante" });
    expect(reponse.statusCode).toBe(200);
    await serveur.close();
  });
});

describe("route /sante/pret", () => {
  it("[A-048] /sante/pret répond 200 quand la base répond avec le rôle console_app", async () => {
    const serveur = construireServeur({ pool: baseFausse(async () => ({ rows: [{ role: "console_app" }] })) });
    const reponse = await serveur.inject({ method: "GET", url: "/sante/pret" });
    expect(reponse.statusCode).toBe(200);
    await serveur.close();
  });

  it("[A-048] attaque : /sante/pret répond 503 sans détail si la base est absente, en panne ou avec un autre rôle", async () => {
    const cas = [
      construireServeur(),
      construireServeur({
        pool: baseFausse(async () => {
          throw new Error("connexion à postgres://console_app:mdp-de-test@interne.test refusée");
        }),
      }),
      construireServeur({ pool: baseFausse(async () => ({ rows: [{ role: "console_migration" }] })) }),
    ];
    for (const serveur of cas) {
      const reponse = await serveur.inject({ method: "GET", url: "/sante/pret" });
      expect(reponse.statusCode).toBe(STATUT_PAR_CODE.porte_fermee);
      expect(reponse.json().erreur.code).toBe("porte_fermee");
      expect(reponse.body).not.toMatch(/mdp-de-test|interne\.test|postgres|console_/);
      await serveur.close();
    }
  });
});
