import { describe, expect, it } from "vitest";
import { construireServeur } from "./serveur.js";
import type { SessionDonnees } from "./donnees/service.js";

// Enregistrement de la route des données dans serveur.ts (T2-37c, étape 3) : fermé par défaut, branché seulement si l'appelant fournit les dépendances.
const A = "11111111-1111-4111-8111-111111111111";
const session: SessionDonnees = { tenantId: A, role: "equipe", acteur: "e1", etablissements: [] };
const post = (s: ReturnType<typeof construireServeur>) => s.inject({ method: "POST", url: "/api/v1/donnees/compterPersonnes", payload: {} });

describe("serveur : route des données", () => {
  it("[A-170] sans dépendances des données, la route n'existe pas (fermé par défaut)", async () => {
    expect((await post(construireServeur())).statusCode).toBe(404);
  });
  it("[A-170] avec les dépendances, la route répond ; le rôle d'équipe lecteur est refusé par le serveur", async () => {
    const appels: string[] = [];
    const deps = (role: string) => ({ session: async () => session, roleEquipe: async () => role, executer: async (_s: SessionDonnees, nom: string) => { appels.push(nom); return [{ total: 1 }]; } });
    expect((await post(construireServeur({ donnees: deps("administrateur") }))).statusCode).toBe(200);
    expect((await post(construireServeur({ donnees: deps("lecteur") }))).statusCode).toBe(403);
    expect(appels).toEqual(["compterPersonnes"]);
  });
});
