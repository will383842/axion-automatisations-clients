import { beforeAll, describe, expect, it } from "vitest";
import { ErreurApi, brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { creerDepotMemoire } from "../../apps/api/src/recherche/memoire.js";
import { routeRecherche } from "../../apps/api/src/routes/recherche.js";
import { fastifyVide } from "../../scripts/liste-routes.js";

// Recherche (T3-09a) : un second administrateur limité au client A ne voit aucune trace de B ; un appelant hors équipe reçoit 403 sans lecture.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const URL = "/api/console/v1/recherche";
let lectures = 0;
const donnees = creerDepotMemoire([
  { type: "client", id: A, client_id: A, libelle: "Atelier Bertin", statut: "client" },
  { type: "client", id: B, client_id: B, libelle: "Atelier Rivoire", statut: "client" },
  { type: "contact", id: "c-b", client_id: B, client_nom: "Atelier Rivoire", libelle: "Bruno Atelier", email: "bruno@exemple.fr", role: "principal" },
  { type: "facture", id: "f-b", client_id: B, client_nom: "Atelier Rivoire", libelle: "AXI-FACT-ATELIER-B", statut: "emise", periode_debut: "2026-02-01", periode_fin: "2026-02-28" },
]);
const depot = { chercher: async (p: Parameters<typeof donnees.chercher>[0]) => { lectures++; return donnees.chercher(p); } };
const membreA = { sujet: "agent-a", role: "second_administrateur", actif: true, portee: { clients: [A], automatisations: [] } };
const sansEquipe = async () => { throw new ErreurApi("action_interdite", "Action interdite."); };
let dans: ReturnType<typeof fastifyVide>;
let hors: ReturnType<typeof fastifyVide>;

beforeAll(async () => {
  dans = fastifyVide();
  brancherErreurs(dans);
  routeRecherche(dans, { ouvert: () => true, exigerEquipe: (async () => undefined) as never, membre: async () => membreA as never, depot, debit: { parMembre: 100, fenetreMs: 10_000 } });
  hors = fastifyVide();
  brancherErreurs(hors);
  routeRecherche(hors, { ouvert: () => true, exigerEquipe: sansEquipe as never, membre: async () => membreA as never, depot, debit: { parMembre: 100, fenetreMs: 10_000 } });
  await Promise.all([dans.ready(), hors.ready()]);
});

describe("recherche : mauvais client", () => {
  it("[C-536] @isolation GET /api/console/v1/recherche", async () => {
    const avant = lectures;
    const rep = await dans.inject({ method: "GET", url: `${URL}?q=atelier` });
    expect(rep.statusCode).toBe(200);
    expect(lectures).toBeGreaterThan(avant);
    for (const trace of [B, "Rivoire", "Bruno", "AXI-FACT-ATELIER-B", "bruno@exemple.fr"]) expect(rep.body).not.toContain(trace);
    expect(rep.body).toContain("Atelier Bertin");
    const apres = lectures;
    const refus = await hors.inject({ method: "GET", url: `${URL}?q=atelier` });
    expect(refus.statusCode).toBe(403);
    expect(lectures).toBe(apres);
  });
});
