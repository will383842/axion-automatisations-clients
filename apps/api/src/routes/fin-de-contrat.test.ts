import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { CHEMIN_ACCUSE, CHEMIN_CONSOLE, CHEMIN_EFFACEMENT, dateFinDansLaFenetre, gestionnairesFinDeContrat } from "./fin-de-contrat.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function serveur(o: { role?: string; reauthentifie?: boolean; acteur?: string; clientActifId?: string } = {}) {
  const appels: string[] = [];
  const existantes = new Map<string, string>();
  const app = Fastify();
  brancherErreurs(app);
  const g = gestionnairesFinDeContrat({
    session: async () => ({ acteur: o.acteur ?? "equipe:u1", role: o.role ?? "administrateur", clientActifId: o.clientActifId ?? A, reauthentifie: o.reauthentifie ?? true }),
    // Modèle de la contrainte d'unicité par client : la première date gagne.
    lancer: async (x) => { appels.push(`lancer:${x.tenantId}:${x.dateFin}:${x.acteur}`); const avant = existantes.get(x.tenantId); if (avant === undefined) { existantes.set(x.tenantId, x.dateFin); return "lancee"; } return avant === x.dateFin ? "deja_lancee" : "autre_date"; },
    maintenant: () => new Date("2026-11-06T09:00:00Z"),
    demanderEffacement: async (t, ref) => { appels.push(`effacement:${t}:${ref}`); },
    confirmer: async (t, j) => { appels.push(`accuse:${t}:${j}`); return j === 1; },
  });
  app.post(CHEMIN_CONSOLE, g.lancer);
  app.post(CHEMIN_EFFACEMENT, g.demandeEffacement);
  app.get(CHEMIN_ACCUSE, g.accuse);
  return { app, appels };
}
const lancer = (app: ReturnType<typeof serveur>["app"], id: string, payload: unknown = { dateFin: "2027-01-10" }) => app.inject({ method: "POST", url: CHEMIN_CONSOLE.replace(":id", id), payload: payload as object });

describe("routes de la fin de contrat", () => {
  it("[C-035] POST fin-de-contrat : le client de l'URL est celui de la session de l'équipe, après réauthentification", async () => {
    const { app, appels } = serveur();
    expect((await lancer(app, A)).statusCode).toBe(202);
    expect(appels).toEqual([`lancer:${A}:2027-01-10:equipe:u1`]);
  });

  it("[C-035] un autre client que celui de la session, sans réauthentification, sans le rôle ou avec un corps invalide : refus, rien n'est lancé", async () => {
    const autre = serveur();
    expect((await lancer(autre.app, B)).statusCode).toBe(403);
    expect((await lancer(serveur({ reauthentifie: false }).app, A)).statusCode).toBe(401);
    expect((await lancer(serveur({ role: "lecteur" }).app, A)).statusCode).toBe(403);
    expect((await lancer(serveur({ acteur: "systeme" }).app, A)).statusCode).toBe(403);
    const v = serveur();
    for (const corps of [{}, { dateFin: "10/01/2027" }, { dateFin: "2027-13-45" }, { dateFin: "2027-01-10", tenantId: B }]) expect((await lancer(v.app, A, corps)).statusCode).toBe(400);
    expect((await lancer(v.app, "pas-un-uuid")).statusCode).toBe(400);
    expect([...autre.appels, ...v.appels]).toEqual([]);
  });

  it("[A-255] la route refuse une date de fin passée ou hors de la fenêtre d'un an : rien n'est lancé", async () => {
    const { app, appels } = serveur();
    for (const dateFin of ["2026-09-01", "2026-11-05", "2027-11-08", "2030-01-01"]) expect((await lancer(app, A, { dateFin })).statusCode, dateFin).toBe(422);
    expect(appels).toEqual([]);
    // Aujourd'hui (Europe/Paris) et dans un an exactement sont permis ; à 23 h 30 UTC il est déjà demain à Paris.
    expect((await lancer(app, A, { dateFin: "2026-11-06" })).statusCode).toBe(202);
    expect(dateFinDansLaFenetre("2027-11-07", new Date("2026-11-06T09:00:00Z"))).toBe(true);
    expect(dateFinDansLaFenetre("2026-11-06", new Date("2026-11-06T23:30:00Z"))).toBe(false);
  });

  it("[C-035] deux lancements en même temps : une seule fin de contrat, la seconde date est refusée, le même rappel est sans effet", async () => {
    const { app } = serveur();
    const [a, b] = await Promise.all([lancer(app, A, { dateFin: "2027-01-10" }), lancer(app, A, { dateFin: "2027-02-10" })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 422]);
    const rejeu = await lancer(app, A, { dateFin: "2027-01-10" });
    expect(rejeu.statusCode).toBe(202);
    expect(rejeu.json()).toEqual({ etat: "deja_lancee" });
  });

  it("[A-253] la demande écrite d'effacement est prise pour le client de la session et ne lance rien d'autre", async () => {
    const { app, appels } = serveur();
    const r = await app.inject({ method: "POST", url: CHEMIN_EFFACEMENT.replace(":id", A), payload: { ecritReference: "objet/ecrit-1" } });
    expect(r.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: CHEMIN_EFFACEMENT.replace(":id", B), payload: { ecritReference: "objet/ecrit-1" } })).statusCode).toBe(403);
    expect(appels).toEqual([`effacement:${A}:objet/ecrit-1`]);
  });

  it("[A-255] le lien d'accusé : même réponse neutre pour un jeton faux ou un jour inconnu", async () => {
    const { app } = serveur();
    const ok = await app.inject({ method: "GET", url: CHEMIN_ACCUSE.replace(":tenantId", A).replace(":jour", "1").replace(":jeton", "abc") });
    expect(ok.statusCode).toBe(200);
    const faux = await app.inject({ method: "GET", url: CHEMIN_ACCUSE.replace(":tenantId", A).replace(":jour", "20").replace(":jeton", "abc") });
    const inconnu = await app.inject({ method: "GET", url: CHEMIN_ACCUSE.replace(":tenantId", A).replace(":jour", "5").replace(":jeton", "abc") });
    expect(faux.statusCode).toBe(404);
    expect(inconnu.statusCode).toBe(404);
    expect(faux.json().erreur.code).toBe(inconnu.json().erreur.code);
    expect(faux.json().erreur.message).toBe(inconnu.json().erreur.message);
  });
});
