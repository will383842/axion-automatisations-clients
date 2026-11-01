import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { LigneJournal } from "../journal-audit/contenu-canonique.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { routeJournal, type FiltreJournal } from "./journal.js";

// Route de lecture du journal pour l'équipe (C-401) : lecture seule, par entité et par période, derrière le contrôle d'accès de l'équipe.
const ligne = (id: number): LigneJournal => ({ id: String(id), tenant_id: null, acteur: "agent-essai", action: "insertion", entite: "contacts", entite_id: "c1", ancienne: null, nouvelle: '{"v": 1}', ip: null, cree: "2026-10-31T10:00:00.000000Z", empreinte_precedente: null, empreinte: "e".repeat(64) });
function serveur(equipe = true) {
  const filtres: FiltreJournal[] = [];
  const app = Fastify();
  brancherErreurs(app);
  routeJournal(app, {
    exigerEquipe: async (_req, rep) => { if (!equipe) return rep.status(403).send({ erreur: { code: "interdit" } }); },
    async lire(f) { filtres.push(f); return [ligne(1), ligne(2)]; },
  });
  return { app, filtres };
}

describe("route du journal d'audit", () => {
  it("[C-401] le journal se lit par entité et par période (route de lecture de l'équipe)", async () => {
    const { app, filtres } = serveur();
    const r = await app.inject({ method: "GET", url: "/equipe/journal?entite=contacts&entiteId=c1&du=2026-10-01T00:00:00.000Z&au=2026-11-01T00:00:00.000Z&limite=2" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ lignes: [{ id: "1" }, { id: "2" }], suivant: "2" });
    expect(filtres).toEqual([{ entite: "contacts", entiteId: "c1", du: "2026-10-01T00:00:00.000Z", au: "2026-11-01T00:00:00.000Z", limite: 2 }]);
  });

  it("[C-401] l'entité est obligatoire, la période doit être ordonnée, la limite bornée, et rien n'est lu", async () => {
    const { app, filtres } = serveur();
    for (const url of ["/equipe/journal", "/equipe/journal?entite=Contacts;drop", "/equipe/journal?entite=contacts&du=2026-11-01T00:00:00.000Z&au=2026-10-01T00:00:00.000Z", "/equipe/journal?entite=contacts&limite=5000", "/equipe/journal?entite=contacts&du=hier"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(400);
    }
    expect(filtres).toEqual([]);
  });

  it("[C-401] sans le contrôle d'accès de l'équipe, rien n'est lu, et aucune route n'écrit", async () => {
    const { app, filtres } = serveur(false);
    expect((await app.inject({ method: "GET", url: "/equipe/journal?entite=contacts" })).statusCode).toBe(403);
    expect(filtres).toEqual([]);
    const ok = serveur().app;
    for (const methode of ["POST", "PUT", "PATCH", "DELETE"] as const) expect((await ok.inject({ method: methode, url: "/equipe/journal?entite=contacts" })).statusCode, methode).toBe(404);
  });
});
