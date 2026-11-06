import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../plugins/erreurs.js";
import { CHEMIN_ACCUSE, CHEMIN_CONSOLE, CHEMIN_EFFACEMENT, gestionnairesFinDeContrat } from "./fin-de-contrat.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function serveur(o: { role?: string; reauthentifie?: boolean; acteur?: string; clientActifId?: string } = {}) {
  const appels: string[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const g = gestionnairesFinDeContrat({
    session: async () => ({ acteur: o.acteur ?? "equipe:u1", role: o.role ?? "administrateur", clientActifId: o.clientActifId ?? A, reauthentifie: o.reauthentifie ?? true }),
    lancer: async (x) => void appels.push(`lancer:${x.tenantId}:${x.dateFin}:${x.acteur}`),
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
    expect(faux.json()).toEqual(inconnu.json());
  });
});
