import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeImportPersonnes, type DepsImportPersonnes } from "./import-personnes.js";

const session = { acteur: "equipe-lemoine", etablissementId: "11111111-1111-4111-8111-111111111111" };
function serveur(ouvert = true) {
  const app = Fastify();
  brancherErreurs(app);
  const ecrit: string[] = [];
  const deps: DepsImportPersonnes = {
    ouvert: () => ouvert,
    session: async () => session,
    ports: { ouvrir: async () => ({ client: { query: async (t: string) => (ecrit.push(t), { rows: [], rowCount: 1 }) }, valider: async () => undefined, annuler: async () => undefined }) },
  };
  routeImportPersonnes(app, deps);
  return { app, ecrit };
}

describe("route d'import de personnes", () => {
  it("[C-060] un fichier avec une colonne interdite reçoit 422 regle_metier / donnees_interdites", async () => {
    const { app } = serveur();
    const r = await app.inject({ method: "POST", url: "/api/v1/import/personnes", payload: { colonnes: ["nom", "numéro de sécu"], lignes: [{ nom: "Bertin" }] } });
    expect(r.statusCode).toBe(422);
    expect(r.json().erreur).toMatchObject({ code: "regle_metier", motif: "donnees_interdites" });
  });

  it("[C-060] un fichier sans colonne interdite est accepté (201)", async () => {
    const { app, ecrit } = serveur();
    const r = await app.inject({ method: "POST", url: "/api/v1/import/personnes", payload: { colonnes: ["nom"], lignes: [{ nom: "Bertin" }] } });
    expect(r.statusCode).toBe(201);
    expect(ecrit.some((t) => /commun\.personnes/.test(t))).toBe(true);
  });

  it("[C-060] l'interrupteur est fermé par défaut : porte fermée, rien n'est écrit", async () => {
    const { app, ecrit } = serveur(false);
    const r = await app.inject({ method: "POST", url: "/api/v1/import/personnes", payload: { colonnes: ["nom"], lignes: [{ nom: "Bertin" }] } });
    expect(r.statusCode).toBe(503);
    expect(ecrit).toEqual([]);
  });

  it("[C-060] un corps mal formé est refusé (400) sans rien écrire", async () => {
    const { app, ecrit } = serveur();
    const r = await app.inject({ method: "POST", url: "/api/v1/import/personnes", payload: { colonnes: "nom" } });
    expect(r.statusCode).toBe(400);
    expect(ecrit).toEqual([]);
  });
});
