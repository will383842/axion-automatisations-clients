import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { MembreDroits } from "../../droits/exiger-droit.js";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeOutils, type DepsOutils } from "./outils.js";

// Outils du client et compatibilité (T3-17b). Entreprise fictive : Lemoine Rénovation.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function serveur(o: { ouvert?: boolean; voit?: string[]; outils?: { famille: string; outil: string; cree_le: string }[] } = {}) {
  const lectures: string[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const membre: MembreDroits = { sujet: "agent-essai", role: "second_administrateur", actif: true, portee: { clients: o.voit ?? [A], automatisations: [] } };
  const deps: DepsOutils = {
    ouvert: () => o.ouvert ?? true,
    exigerEquipe: (async () => undefined) as never,
    droits: { membre: async () => membre, absenceOuverte: async () => false, tracer: async () => undefined },
    depot: {
      async outils(id) { lectures.push(id); return (o.outils ?? []) as never; },
      async catalogue() { lectures.push("catalogue"); return [{ code: "AUT-101", nom: "Rappel de rendez-vous", familles: ["agenda"] }]; },
      async connecteurs() { lectures.push("connecteurs"); return [{ famille: "agenda", outil: "microsoft_365" }]; },
    },
  };
  routeOutils(app, deps);
  return { app, lectures };
}
const url = (id: string) => `/api/console/v1/clients/${id}/outils`;

describe("route des outils du client", () => {
  it("[A-409] la liste des outils rend famille, outil et date de saisie, clés exactes", async () => {
    const { app } = serveur({ outils: [{ famille: "agenda", outil: "microsoft_365", cree_le: "2026-11-07T08:42Z", contenu: "ne sort pas" } as never] });
    const rep = await app.inject({ method: "GET", url: url(A) });
    expect(rep.statusCode).toBe(200);
    expect(Object.keys(rep.json()).sort()).toEqual(["a_creer", "compatibles", "impossibles", "outils"]);
    expect(rep.json().outils).toEqual([{ famille: "agenda", outil: "microsoft_365", cree_le: "2026-11-07T08:42Z" }]);
  });

  it("[A-409] aucun outil noté : listes vides, réponse 200", async () => {
    const { app } = serveur();
    const rep = await app.inject({ method: "GET", url: url(A) });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().outils).toEqual([]);
  });

  it("[A-410] la route rend les trois listes calculées sur le catalogue", async () => {
    const { app } = serveur({ outils: [{ famille: "agenda", outil: "microsoft_365", cree_le: "2026-11-07T08:42Z" }] });
    const j = (await app.inject({ method: "GET", url: url(A) })).json();
    expect(j.compatibles.map((x: { code: string }) => x.code)).toEqual(["AUT-101"]);
    expect(j.compatibles[0].gamme_conseillee).toBeNull();
    expect(j.a_creer).toEqual([]);
    expect(j.impossibles).toEqual([]);
  });

  it("[B-126] @isolation les outils d'un client hors portée répondent 404 sans lecture", async () => {
    const { app, lectures } = serveur({ voit: [A] });
    const rep = await app.inject({ method: "GET", url: url(B) });
    expect(rep.statusCode).toBe(404);
    expect(lectures).toEqual([]);
  });

  it("[LOT3-outils] la porte fermée des outils rend 503 sans lecture", async () => {
    const { app, lectures } = serveur({ ouvert: false });
    expect((await app.inject({ method: "GET", url: url(A) })).statusCode).toBe(503);
    expect(lectures).toEqual([]);
  });

  it("[LOT3-outils] un identifiant de client non UUID rend 400 sans lecture", async () => {
    const { app, lectures } = serveur();
    expect((await app.inject({ method: "GET", url: url("pas-un-uuid") })).statusCode).toBe(400);
    expect(lectures).toEqual([]);
  });
});
