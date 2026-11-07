import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeImport, type DepsImport } from "./import.js";
import type { TransactionImport } from "../import/importer.ts";

// Route d'import (T2-47b) : fermée par défaut (503), session fournie par l'appelant (jamais le corps), refus d'une colonne interdite validé (COMMIT) puis erreur 422.
const ETAB = "11111111-1111-4111-8111-111111111111";
function monter(ouvert: boolean) {
  const journal: string[] = [];
  const sessionsVues: unknown[] = [];
  const deps: DepsImport = {
    ouvert,
    session: async () => ({ acteur: "equipe-lemoine", etablissementId: ETAB }),
    ports: (s) => ({
      ouvrir: async (): Promise<TransactionImport> => {
        sessionsVues.push(s);
        return {
          client: { query: async (t: string) => (journal.push(t.split(" ").slice(0, 3).join(" ")), { rows: [], rowCount: 1 }) },
          valider: async () => void journal.push("COMMIT"),
          annuler: async () => void journal.push("ROLLBACK"),
        };
      },
    }),
  };
  const appli = Fastify();
  brancherErreurs(appli);
  routeImport(appli, deps);
  return { appli, journal, sessionsVues };
}
const envoyer = (appli: ReturnType<typeof monter>["appli"], corps: unknown) => appli.inject({ method: "POST", url: "/api/v1/import/personnes", payload: corps as object });

describe("route d'import de personnes", () => {
  it("[C-060] la route est fermée par défaut : 503 et rien n'est ouvert", async () => {
    const { appli, journal, sessionsVues } = monter(false);
    const r = await envoyer(appli, { colonnes: ["nom"], lignes: [{ nom: "Bertin" }] });
    expect(r.statusCode).toBe(503);
    expect(journal).toEqual([]);
    expect(sessionsVues).toEqual([]);
  });

  it("[C-060] verifierImport est appelé par la route : une colonne IBAN donne 422, la trace est validée (COMMIT) sans ROLLBACK", async () => {
    const { appli, journal } = monter(true);
    const r = await envoyer(appli, { colonnes: ["nom", "IBAN"], lignes: [{ nom: "Bertin", IBAN: "x" }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().erreur.code).toBe("regle_metier");
    expect(journal).toEqual(["INSERT INTO trace.evenements", "COMMIT"]);
  });

  it("[A-033] le message du refus renvoyé par la route ne contient aucune valeur du fichier", async () => {
    const { appli } = monter(true);
    const r = await envoyer(appli, { colonnes: ["nom", "IBAN"], lignes: [{ nom: "MARQUEUR-ESSAI-abc", IBAN: "FR76-INVENTE" }] });
    expect(r.body).not.toMatch(/MARQUEUR-ESSAI|FR76-INVENTE/);
  });

  it("[C-027] un import accepté répond 200 et écrit dans la base de la session, puis valide", async () => {
    const { appli, journal, sessionsVues } = monter(true);
    const r = await envoyer(appli, { colonnes: ["nom", "prenom"], lignes: [{ nom: "Bertin", prenom: "Anne" }] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ importees: 1 });
    expect(journal).toEqual(["INSERT INTO commun.personnes", "COMMIT"]);
    expect(sessionsVues).toEqual([{ acteur: "equipe-lemoine", etablissementId: ETAB }]);
  });

  it("[C-027] l'établissement vient de la session : un etablissementId dans le corps est refusé (400), rien n'est ouvert", async () => {
    const { appli, sessionsVues } = monter(true);
    const r = await envoyer(appli, { colonnes: ["nom"], lignes: [{ nom: "Bertin" }], etablissementId: "22222222-2222-4222-8222-222222222222" });
    expect(r.statusCode).toBe(400);
    expect(sessionsVues).toEqual([]);
  });

  it("[C-060] un corps mal formé (lignes non textuelles, trop de lignes) est refusé en 400", async () => {
    const { appli } = monter(true);
    expect((await envoyer(appli, { colonnes: ["nom"], lignes: [{ nom: 3 }] })).statusCode).toBe(400);
    expect((await envoyer(appli, { colonnes: ["nom"], lignes: Array.from({ length: 5001 }, () => ({ nom: "x" })) })).statusCode).toBe(400);
  });
});
