import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { MembreDroits } from "../../droits/exiger-droit.js";
import { depotVuesEnMemoire, type LigneClient } from "../../clients/liste.js";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeClients, type DepsClients, type TraceExport } from "./liste.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const L = (n: number, p: Partial<LigneClient>): LigneClient => ({ id: id(n), nom: "Atelier Bertin", formule: "abonnement", sante: "bon", statut: "client", apporteur: null, modeleIa: null, metier: null, ...p });
const JEU = [
  L(1, { nom: "Lemoine Rénovation", metier: "batiment" }),
  L(2, { nom: "Boulangerie Rivoire", formule: "achat" }),
  L(3, { nom: '=HYPERLINK("http://exemple.test")', formule: "abonnement" }),
  L(4, { nom: "Garage Fontaine", formule: "installation_maintenance" }),
];
const DIRIGEANT: MembreDroits = { sujet: "dirigeant-test", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } };
const AUTRE: MembreDroits = { sujet: "autre-test", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } };
const LIMITE: MembreDroits = { sujet: "second-test", role: "second_administrateur", actif: true, portee: { clients: [id(1)], automatisations: [] } };

function montage(o: { membre?: MembreDroits; ouvert?: boolean; vues?: ReturnType<typeof depotVuesEnMemoire>; echecTrace?: boolean } = {}) {
  const app = Fastify();
  brancherErreurs(app);
  const traces: TraceExport[] = [];
  const vues = o.vues ?? depotVuesEnMemoire();
  const deps: DepsClients = {
    ouvert: () => o.ouvert ?? true,
    exigerEquipe: (async () => undefined) as never,
    membre: async () => o.membre ?? DIRIGEANT,
    clients: { toutes: async () => JEU },
    vues,
    tracerExport: async (e) => { if (o.echecTrace) throw new Error("trace impossible"); traces.push(e); },
  };
  routeClients(app, deps);
  return { app, traces, vues };
}
const B = "/api/console/v1/clients";

describe("routes de la liste des clients", () => {
  it("[B-005] GET /clients filtre, recherche et pagine par curseur", async () => {
    const { app } = montage();
    expect((await app.inject({ url: `${B}?formule=achat` })).json().lignes.map((l: { nom: string }) => l.nom)).toEqual(["Boulangerie Rivoire"]);
    const p1 = (await app.inject({ url: `${B}?taille=3` })).json();
    expect(p1.lignes).toHaveLength(3);
    const p2 = (await app.inject({ url: `${B}?taille=3&curseur=${encodeURIComponent(p1.curseur_suivant)}` })).json();
    expect(p2.lignes).toHaveLength(1);
    expect(p2.curseur_suivant).toBeNull();
    expect((await app.inject({ url: `${B}?inconnu=1` })).statusCode).toBe(400);
  });

  it("[B-006] une vue enregistrée se rouvre avec ses filtres et n'est visible que de son auteur", async () => {
    const vues = depotVuesEnMemoire();
    const moi = montage({ vues });
    const cree = await moi.app.inject({ method: "POST", url: `${B}/vues`, payload: { nom: "Mes achats", filtres: { formule: "achat" } } });
    expect(cree.statusCode).toBe(201);
    const { id: idVue } = cree.json();
    const liste = (await moi.app.inject({ url: `${B}/vues` })).json().vues;
    expect(liste.map((v: { nom: string }) => v.nom)).toEqual(["Mes abonnements", "Mes achats"]);
    const ouverte = (await moi.app.inject({ url: `${B}?vue=${idVue}` })).json();
    expect(ouverte.lignes.map((l: { nom: string }) => l.nom)).toEqual(["Boulangerie Rivoire"]);
    const lui = montage({ vues, membre: AUTRE });
    expect((await lui.app.inject({ url: `${B}/vues` })).json().vues.map((v: { nom: string }) => v.nom)).toEqual(["Mes abonnements"]);
    expect((await lui.app.inject({ url: `${B}?vue=${idVue}` })).statusCode).toBe(404);
    expect((await moi.app.inject({ method: "POST", url: `${B}/vues`, payload: { nom: "x", filtres: { colonne: "secret" } } })).statusCode).toBe(400);
  });

  it("[C-579] l'export CSV contient exactement les lignes filtrées et se trace au journal", async () => {
    const { app, traces } = montage();
    const r = await app.inject({ method: "POST", url: `${B}/export`, payload: { filtres: { formule: "abonnement" } } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    const lignes = r.body.trimEnd().split("\r\n");
    expect(lignes).toHaveLength(3);
    expect(r.body).toContain("Lemoine Rénovation");
    expect(r.body).not.toContain("Boulangerie Rivoire");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ sujet: "dirigeant-test", filtres: { formule: "abonnement" }, lignes: 2 });
    expect(traces[0]!.empreinte).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[C-579] un export dont la trace échoue ne livre aucun fichier", async () => {
    const { app } = montage({ echecTrace: true });
    const r = await app.inject({ method: "POST", url: `${B}/export`, payload: {} });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("Lemoine");
  });

  it("[C-579] un nom venu du CRM qui commence par = est neutralisé dans le fichier", async () => {
    const { app } = montage();
    const r = await app.inject({ method: "POST", url: `${B}/export`, payload: {} });
    expect(r.body).toContain(`"'=HYPERLINK`);
    expect(r.body).not.toMatch(/(^|,)"=/m);
  });

  it("[C-579] un paramètre de filtre ne peut ajouter aucune colonne au fichier", async () => {
    const { app, traces } = montage();
    for (const payload of [{ colonnes: ["secret"] }, { filtres: { colonnes: "x" } }, { filtres: { champ: "token" } }]) {
      expect((await app.inject({ method: "POST", url: `${B}/export`, payload })).statusCode).toBe(400);
    }
    expect(traces).toEqual([]);
  });

  it("[C-579] l'export d'une vue d'un autre membre par son identifiant est refusé", async () => {
    const vues = depotVuesEnMemoire();
    const moi = montage({ vues });
    const { id: idVue } = (await moi.app.inject({ method: "POST", url: `${B}/vues`, payload: { nom: "Privée", filtres: {} } })).json();
    const lui = montage({ vues, membre: AUTRE });
    const r = await lui.app.inject({ method: "POST", url: `${B}/export`, payload: { vue: idVue } });
    expect(r.statusCode).toBe(404);
    expect(lui.traces).toEqual([]);
  });

  it("[B-126] @isolation l'export ne contient aucun client hors portée", async () => {
    const { app, traces } = montage({ membre: LIMITE });
    const r = await app.inject({ method: "POST", url: `${B}/export`, payload: {} });
    expect(r.body).toContain("Lemoine Rénovation");
    for (const hors of ["Boulangerie", "HYPERLINK", "Garage"]) expect(r.body).not.toContain(hors);
    expect(traces[0]!.lignes).toBe(1);
    const liste = (await app.inject({ url: B })).json().lignes;
    expect(liste).toHaveLength(1);
    const vide = montage({ membre: { ...LIMITE, portee: { clients: [], automatisations: [] } } });
    expect((await vide.app.inject({ url: B })).json().lignes).toEqual([]);
  });

  it("[LOT3-droits] un rôle inconnu ou inactif est refusé, la porte fermée répond 503", async () => {
    expect((await montage({ membre: { ...DIRIGEANT, role: "support" as never } }).app.inject({ url: B })).statusCode).toBe(403);
    expect((await montage({ membre: { ...DIRIGEANT, actif: false } }).app.inject({ url: B })).statusCode).toBe(403);
    expect((await montage({ ouvert: false }).app.inject({ url: B })).statusCode).toBe(503);
    expect((await montage({ ouvert: false }).app.inject({ method: "POST", url: `${B}/export`, payload: {} })).statusCode).toBe(503);
  });
});
