import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { DepsDroits, MembreDroits } from "../../droits/exiger-droit.js";
import { brancherErreurs, ErreurApi } from "../../plugins/erreurs.js";
import type { LigneConnexion } from "../../connexions/vue.js";
import { routeConnexions, type DepsConnexions } from "./connexions.js";

// Liste des connexions d'un client (T3-17a) : équipe seule, droit « lire », client dans la portée sinon 404, 503 tant que `ouvert()` est faux.
const MARQUEUR = "MARQUEUR-" + randomBytes(8).toString("hex");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const brute = {
  id: "c1", outil: "messagerie", connecteur: "microsoft365", etat: "active", expire_le: null, dernier_test_le: null,
  automatisation_code: null, automatisation_nom: null, contact_nom: null, contact_role: null,
  reference_coffre: `bao:clients/${A}/${MARQUEUR}`,
} as unknown as LigneConnexion;
const membre = (clients: string[]): MembreDroits => ({ sujet: "m1", role: "second_administrateur", actif: true, portee: { clients, automatisations: [] } });

function serveur(o: { ouvert?: boolean; clients?: string[]; equipe?: boolean; lignes?: LigneConnexion[] } = {}) {
  const lectures: string[] = [];
  const journal: string[] = [];
  const app = Fastify({ logger: { level: "info", stream: { write: (l: string) => { journal.push(l); } } } });
  brancherErreurs(app);
  const droits: DepsDroits = { membre: async () => membre(o.clients ?? [A]), absenceOuverte: async () => false, tracer: async () => undefined };
  const deps: DepsConnexions = {
    ouvert: () => o.ouvert ?? true,
    exigerEquipe: (async () => { if (o.equipe === false) throw new ErreurApi("action_interdite", "Action interdite."); }) as never,
    droits,
    session: async () => ({ acteur: "agent-essai" }),
    async lire(id) { lectures.push(id); return o.lignes ?? [brute]; },
  };
  routeConnexions(app, deps);
  return { app, lectures, journal };
}
const url = (id: string) => `/api/console/v1/clients/${id}/connexions`;

describe("route des connexions d'un client", () => {
  it("[C-013] le marqueur posé au coffre de test ne sort ni de la réponse ni du journal", async () => {
    const { app, journal } = serveur();
    const r = await app.inject({ method: "GET", url: url(A) });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(MARQUEUR);
    expect(r.json().connexions).toHaveLength(1);
    expect(journal.join("")).not.toContain(MARQUEUR);
  });

  it("[B-126] @isolation la liste des connexions d'un client hors portée répond 404 sans lecture", async () => {
    const { app, lectures } = serveur({ clients: [A] });
    const r = await app.inject({ method: "GET", url: url(B) });
    expect(r.statusCode).toBe(404);
    expect(r.json().erreur.code).toBe("introuvable");
    expect(lectures).toEqual([]);
  });

  it("[LOT3-outils] sans session d'équipe, la réponse est 403 sans lecture", async () => {
    const { app, lectures } = serveur({ equipe: false });
    expect((await app.inject({ method: "GET", url: url(A) })).statusCode).toBe(403);
    expect(lectures).toEqual([]);
  });

  it("[LOT3-outils] la porte fermée rend 503 sans lecture", async () => {
    const { app, lectures } = serveur({ ouvert: false });
    const r = await app.inject({ method: "GET", url: url(A) });
    expect(r.statusCode).toBe(503);
    expect(r.json().erreur.code).toBe("porte_fermee");
    expect(lectures).toEqual([]);
  });

  it("[LOT3-outils] un identifiant de client non UUID rend 400 sans lecture", async () => {
    const { app, lectures } = serveur();
    const r = await app.inject({ method: "GET", url: url("pas-un-uuid") });
    expect(r.statusCode).toBe(400);
    expect(lectures).toEqual([]);
  });
});
