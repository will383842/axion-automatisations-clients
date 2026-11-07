import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { exigerReauthentification } from "../../auth/exiger-reauthentification.js";
import type { ServiceGrilles } from "../../catalogue/grille.js";
import { TOUS_LES_CLIENTS } from "../../droits/portee.js";
import type { MembreDroits, TraceRefus } from "../../droits/exiger-droit.js";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeGrillesCatalogue } from "./grilles.js";

// Routes de la grille de prix (T3-31a1) : porte, équipe, réauthentification (POST), droit, puis seulement paramètres et corps.
const AUTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAINTENANT = Date.UTC(2026, 10, 7, 12, 0, 0);
const CORPS = { formules: ["abonnement"], frais_mise_en_place_ht_centimes: "12345", prix_mensuel_ht_centimes: "6789", maintenance_ensuite_ht_centimes: "1500", maintenance_incluse_mois: 3, grille_precedente_id: null, motif: "Essai" };
const GRILLE = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", formules: ["abonnement"], formules_proposees: ["abonnement"], frais_mise_en_place_ht_centimes: "12345", prix_mensuel_ht_centimes: "6789", maintenance_incluse_mois: 3, maintenance_ensuite_ht_centimes: "1500", auteur: "agent-essai", cree_le: "2026-11-07T09:00:00.000Z" };

function serveur(o: { ouvert?: boolean } = {}) {
  const appels: string[] = [];
  const traces: TraceRefus[] = [];
  const service: ServiceGrilles = {
    async lire() { appels.push("lire"); return { automatisation_id: AUTO, grille: GRILLE, masquee_par_defaut: [] }; },
    async historique() { appels.push("historique"); return []; },
    async ecrire() { appels.push("ecrire"); return { grille: GRILLE, historique: [], masquee_par_defaut: [] }; },
  };
  const app = Fastify();
  brancherErreurs(app);
  // Identité de l'essai : lue des en-têtes (auth_time en secondes d'âge, acr, rôle). Le jeton réel est celui du crochet fourni par l'appelant.
  app.addHook("onRequest", async (requete) => {
    const age = Number(requete.headers["x-age"] ?? 1);
    requete.identite = { auth_time: Math.floor(MAINTENANT / 1000) - age, acr: String(requete.headers["x-acr"] ?? "mfa") };
  });
  routeGrillesCatalogue(app, {
    ouvert: o.ouvert ?? true,
    exigerEquipe: (async () => { appels.push("equipe"); }) as never,
    exigerReauthentification: exigerReauthentification(() => MAINTENANT),
    droits: {
      async membre(requete) {
        const role = String(requete.headers["x-role"] ?? "dirigeant") as MembreDroits["role"];
        return { sujet: "m1", role, actif: true, portee: { clients: requete.headers["x-portee"] === "tous" ? [TOUS_LES_CLIENTS] : [], automatisations: [] } };
      },
      absenceOuverte: async () => false,
      async tracer(t) { traces.push(t); },
    },
    acteur: async () => "agent-essai",
    service,
  });
  return { app, appels, traces };
}
const sansEquipe = (appels: string[]) => appels.filter((a) => a !== "equipe");
const ecrire = (app: ReturnType<typeof serveur>["app"], entetes: Record<string, string> = {}, payload: unknown = CORPS) =>
  app.inject({ method: "POST", url: `/api/console/v1/catalogue/automatisations/${AUTO}/grille`, headers: entetes, payload: payload as never });

describe("routes de la grille de prix", () => {
  it("[LOT3-prix] écrire une grille sans réauthentification récente est refusé", async () => {
    const { app, appels } = serveur();
    for (const entetes of [{ "x-age": "301" }, { "x-acr": "pwd" }]) {
      const r = await ecrire(app, entetes);
      expect(r.statusCode).toBe(401);
      expect(r.json().erreur.code).toBe("reauthentification_requise");
    }
    expect(sansEquipe(appels)).toEqual([]);
    expect((await ecrire(app)).statusCode).toBe(201);
    expect(sansEquipe(appels)).toEqual(["ecrire"]);
  });

  it("[LOT3-prix] un second administrateur ne peut pas écrire une grille, et le refus est tracé", async () => {
    const { app, appels, traces } = serveur();
    const r = await ecrire(app, { "x-role": "second_administrateur", "x-portee": "tous" });
    expect(r.statusCode).toBe(403);
    expect(r.json().erreur.code).toBe("action_interdite");
    expect(sansEquipe(appels)).toEqual([]);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ action: "publier_catalogue", sujet: "m1" });
  });

  it("[LOT3-prix] un second administrateur à portée complète peut lire la grille et son historique", async () => {
    const { app, appels } = serveur();
    const entetes = { "x-role": "second_administrateur", "x-portee": "tous" };
    expect((await app.inject({ method: "GET", url: `/api/console/v1/catalogue/automatisations/${AUTO}/grille`, headers: entetes })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/console/v1/catalogue/automatisations/${AUTO}/grille/historique?limite=10`, headers: entetes })).statusCode).toBe(200);
    expect(sansEquipe(appels)).toEqual(["lire", "historique"]);
    // Portée partielle : route globale, échec fermé (404).
    const partiel = await app.inject({ method: "GET", url: `/api/console/v1/catalogue/automatisations/${AUTO}/grille`, headers: { "x-role": "second_administrateur" } });
    expect(partiel.statusCode).toBe(404);
  });

  it("[LOT3-prix] la porte fermée rend 503 sur les trois routes, sans appel", async () => {
    const { app, appels } = serveur({ ouvert: false });
    const base = `/api/console/v1/catalogue/automatisations/${AUTO}/grille`;
    // Aucun en-tête d'identité utile : la porte passe en premier, avant même le contrôle d'équipe.
    for (const [methode, url] of [["GET", base], ["GET", `${base}/historique`], ["POST", base]] as const) {
      const r = await app.inject({ method: methode, url, headers: { "x-age": "9999" }, ...(methode === "POST" ? { payload: CORPS } : {}) });
      expect(r.statusCode).toBe(503);
      expect(r.json().erreur.code).toBe("porte_fermee");
    }
    expect(appels).toEqual([]);
  });

  it("[LOT3-prix] le corps refuse un champ tva ou ttc et la réponse ne porte que des montants HT", async () => {
    const { app, appels } = serveur();
    for (const ajout of [{ tva: "2000" }, { ttc: "8000" }, { taux: "20" }]) {
      const r = await ecrire(app, {}, { ...CORPS, ...ajout });
      expect(r.statusCode).toBe(400);
    }
    expect(sansEquipe(appels)).toEqual([]);
    const ok = (await ecrire(app)).json();
    expect(Object.keys(ok).sort()).toEqual(["grille", "historique", "masquee_par_defaut"]);
    expect(Object.keys(ok.grille).sort()).toEqual(["auteur", "cree_le", "formules", "formules_proposees", "frais_mise_en_place_ht_centimes", "id", "maintenance_ensuite_ht_centimes", "maintenance_incluse_mois", "prix_mensuel_ht_centimes"]);
    expect(JSON.stringify(ok)).not.toMatch(/tva|ttc/i);
  });

  it("[LOT3-prix] un identifiant d'automatisation hors UUID rend 400 sans appel", async () => {
    const { app, appels } = serveur();
    const base = "/api/console/v1/catalogue/automatisations/pas-un-uuid/grille";
    expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${base}/historique` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: base, payload: CORPS })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/console/v1/catalogue/automatisations/${AUTO}/grille/historique?limite=201` })).statusCode).toBe(400);
    expect(sansEquipe(appels)).toEqual([]);
  });
});
