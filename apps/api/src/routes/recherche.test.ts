import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { creerDepotMemoire, type LigneMemoire } from "../recherche/memoire.js";
import type { DepotRecherche, ParametresRecherche } from "../recherche/index.js";
import { brancherErreurs, ErreurApi } from "../plugins/erreurs.js";
import { construireServeur } from "../serveur.js";
import { routeRecherche, type DepsRecherche } from "./recherche.js";

// Route de la recherche (T3-09a) : porte, équipe, terme, membre, débit, portée, dépôt, dans cet ordre.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const URL = "/api/console/v1/recherche";
const membreA = { sujet: "agent-a", role: "second_administrateur", actif: true, portee: { clients: [A], automatisations: [] } };
const lignes = (): LigneMemoire[] => [
  { type: "client", id: A, client_id: A, libelle: "Atelier Bertin", statut: "client" },
  { type: "contact", id: "c1", client_id: A, client_nom: "Atelier Bertin", libelle: "Claire Bertin", email: "claire@exemple.fr", role: "principal" },
  { type: "facture", id: "f1", client_id: A, client_nom: "Atelier Bertin", libelle: "AXI-FACT-0001", statut: "emise", periode_debut: "2026-02-01", periode_fin: "2026-02-28" },
  { type: "demande", id: "33333333-3333-4333-8333-333333333333", client_id: A, client_nom: "Atelier Bertin", libelle: "question", statut: "nouvelle", cree_le: "2026-11-01T08:00:00Z" },
  { type: "instance", id: "i1", client_id: A, client_nom: "Atelier Bertin", libelle: "relance-devis", automatisation_nom: null, etat: "active" },
  { type: "client", id: B, client_id: B, libelle: "Boulangerie Rivoire", statut: "client" },
];
function monter(o: Partial<DepsRecherche> & { depot?: DepotRecherche } = {}) {
  const vus: ParametresRecherche[] = [];
  const base = creerDepotMemoire(lignes());
  const depot: DepotRecherche = o.depot ?? { chercher: async (p) => { vus.push(p); return base.chercher(p); } };
  const app = Fastify();
  brancherErreurs(app);
  routeRecherche(app, { ouvert: () => true, exigerEquipe: (async () => undefined) as never, membre: async () => membreA as never, depot, debit: { parMembre: 100, fenetreMs: 10_000 }, ...o, ...(o.depot ? {} : { depot }) });
  return { app, vus };
}
const chercher = (app: ReturnType<typeof monter>["app"], query: Record<string, string | string[]>) => app.inject({ method: "GET", url: URL, query });

describe("route de la recherche", () => {
  it("[B-074] GET /recherche rend les cinq groupes avec des clés fermées, sans montant ni référence de texte", async () => {
    const { app } = monter();
    const rep = await chercher(app, { q: "bertin" });
    expect(rep.statusCode).toBe(200);
    const corps = rep.json();
    expect(Object.keys(corps)).toEqual(["groupes"]);
    expect(corps.groupes.map((g: { type: string }) => g.type)).toEqual(["client", "contact", "facture", "demande", "instance"]);
    const cles = (g: number) => Object.keys(corps.groupes[g].resultats[0] ?? {}).sort();
    expect(cles(0)).toEqual(["client_id", "id", "libelle", "statut", "type"]);
    expect(cles(1)).toEqual(["client_id", "client_nom", "email", "id", "libelle", "role", "type"]);
    expect(cles(2)).toEqual(["client_id", "client_nom", "id", "libelle", "periode_debut", "periode_fin", "statut", "type"]);
    expect(cles(3)).toEqual(["client_id", "client_nom", "cree_le", "id", "libelle", "statut", "type"]);
    expect(cles(4)).toEqual(["automatisation_nom", "client_id", "client_nom", "etat", "id", "libelle", "type"]);
    expect(rep.body).not.toMatch(/montant|reference_texte|demande:|Rivoire/);
  });

  it("[LOT3-recherche] un terme de moins de 2 ou de plus de 100 caractères, ou porteur d'un caractère de contrôle, rend 400 sans lecture", async () => {
    const { app, vus } = monter();
    for (const q of ["", "a", " b ", "x".repeat(101), "x".repeat(10_000), "ab\ncd", "ab\u0000cd", "ab‮cd"]) expect((await chercher(app, { q })).statusCode, JSON.stringify(q.slice(0, 5))).toBe(400);
    expect((await app.inject({ method: "GET", url: URL })).statusCode).toBe(400);
    expect((await chercher(app, { q: "x".repeat(100) })).statusCode).toBe(200);
    expect((await chercher(app, { q: "  ab   cd  " })).statusCode).toBe(200);
    expect(vus).toHaveLength(2);
    expect(vus[1]?.terme).toBe("ab cd");
  });

  it("[LOT3-recherche] un terme porteur de SQL ou de jokers est cherché comme du texte", async () => {
    const { app, vus } = monter();
    for (const q of ["'; DROP TABLE organisations; --", "50%", "%%", "_x", "a\\b"]) expect((await chercher(app, { q })).statusCode).toBe(200);
    expect(vus.map((p) => p.motif)).toEqual(["%'; DROP TABLE organisations; --%", "%50\\%%", "%\\%\\%%", "%\\_x%", "%a\\\\b%"]);
  });

  it("[LOT3-recherche] un paramètre inconnu ou répété rend 400", async () => {
    const { app, vus } = monter();
    for (const query of [{ q: "ab", portee: "*" }, { q: "ab", tenant_id: B }, { q: "ab", type: "client" }, { q: ["ab", "cd"] }, { q: "ab", limite: "0" }, { q: "ab", limite: "21" }, { q: "ab", limite: "x" }, { q: "ab", limite: ["1", "2"] }]) {
      expect((await chercher(app, query)).statusCode, JSON.stringify(query)).toBe(400);
    }
    expect((await chercher(app, { q: "ab", limite: "20" })).statusCode).toBe(200);
    expect(vus).toHaveLength(1);
    expect(vus[0]?.limite).toBe(20);
    await chercher(app, { q: "ab" });
    expect(vus[1]?.limite).toBe(5);
  });

  it("[LOT3-recherche] au-delà du débit d'un membre, 429 debit_depasse avec Retry-After, sans lecture", async () => {
    let maintenant = 1_000_000;
    const sujets = ["agent-a", "agent-a", "agent-a", "agent-b"];
    let i = 0;
    const { app, vus } = monter({ debit: { parMembre: 2, fenetreMs: 10_000 }, maintenant: () => maintenant, membre: async () => ({ ...membreA, sujet: sujets[Math.min(i++, 3)] }) as never });
    expect((await chercher(app, { q: "ab" })).statusCode).toBe(200);
    maintenant += 2_500;
    expect((await chercher(app, { q: "ab" })).statusCode).toBe(200);
    const refus = await chercher(app, { q: "ab" });
    expect(refus.statusCode).toBe(429);
    expect(refus.json().erreur.code).toBe("debit_depasse");
    expect(refus.headers["retry-after"]).toBe("8");
    expect(vus).toHaveLength(2);
    expect((await chercher(app, { q: "ab" })).statusCode).toBe(200);
    maintenant += 10_000;
    i = 0;
    expect((await chercher(app, { q: "ab" })).statusCode).toBe(200);
  });

  it("[LOT3-recherche] un rôle inconnu ou un membre inactif reçoit 403, la porte fermée 503, sans lecture", async () => {
    for (const membre of [{ ...membreA, role: "inconnu" }, { ...membreA, actif: false }, undefined]) {
      const { app, vus } = monter({ membre: async () => membre as never });
      const rep = await chercher(app, { q: "ab" });
      expect([rep.statusCode, rep.json().erreur.code]).toEqual([403, "action_interdite"]);
      expect(vus).toHaveLength(0);
    }
    const ferme = monter({ ouvert: () => false });
    const rep = await chercher(ferme.app, { q: "ab" });
    expect([rep.statusCode, rep.json().erreur.code]).toEqual([503, "porte_fermee"]);
    expect(ferme.vus).toHaveLength(0);
    const sansEquipe = monter({ exigerEquipe: (async () => { throw new ErreurApi("action_interdite", "Réservé à l'équipe."); }) as never });
    expect((await chercher(sansEquipe.app, { q: "ab" })).statusCode).toBe(403);
    expect(sansEquipe.vus).toHaveLength(0);
  });

  it("[LOT3-recherche] le terme cherché n'apparaît jamais au journal", async () => {
    const TERME = "Bertin-Secret-7f3a";
    const lignesJournal: string[] = [];
    const journal = { write: (l: string) => void lignesJournal.push(l) };
    const base = creerDepotMemoire(lignes());
    const ok = construireServeur({ journal, recherche: { ouvert: () => true, exigerEquipe: (async () => undefined) as never, membre: async () => membreA as never, depot: base, debit: { parMembre: 10, fenetreMs: 1000 } } });
    expect((await ok.inject({ method: "GET", url: `${URL}?q=${TERME}` })).statusCode).toBe(200);
    expect((await ok.inject({ method: "GET", url: `${URL}?q=${TERME}&portee=*` })).statusCode).toBe(400);
    const casse = construireServeur({ journal, recherche: { ouvert: () => true, exigerEquipe: (async () => undefined) as never, membre: async () => membreA as never, depot: { chercher: async () => { throw new Error("panne du dépôt"); } }, debit: { parMembre: 10, fenetreMs: 1000 } } });
    const rep = await casse.inject({ method: "GET", url: `${URL}?q=${TERME}` });
    expect([rep.statusCode, rep.json().erreur.code]).toEqual([500, "erreur_interne"]);
    expect(rep.body).not.toContain(TERME);
    expect(lignesJournal.length).toBeGreaterThan(0);
    expect(lignesJournal.join("\n")).not.toContain(TERME);
  });

  it("[LOT3-recherche] sans l'option recherche, la route n'existe pas", async () => {
    const rep = await construireServeur().inject({ method: "GET", url: `${URL}?q=ab` });
    expect(rep.statusCode).toBe(404);
  });
});
