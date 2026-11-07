import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { ordonnerNotes, routeNotes, type DepsNotes, type Note } from "./notes.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ALERTE = "44444444-4444-4444-8444-444444444444";
const N1 = "55555555-5555-4555-8555-555555555555";
const note = (id: string, cree_le: string, epinglee = false): Note => ({ id, type: "note", texte: "t", auteur: "agent-essai", epinglee, cree_le });

function serveur(o: { ouvert?: boolean; alerteConnue?: boolean } = {}) {
  const appels: unknown[][] = [];
  const traces: unknown[] = [];
  const app = Fastify();
  brancherErreurs(app);
  const deps: DepsNotes = {
    ouvert: () => o.ouvert ?? true,
    exigerEquipe: (async () => undefined) as never,
    session: async () => ({ acteur: "agent-essai", peutVoir: (id: string) => id === A }),
    async lister(c) { appels.push(["lister", c]); return [note("a", "2026-11-01T10:00:00Z"), note("b", "2026-11-05T10:00:00Z"), note("c", "2026-10-01T10:00:00Z", true)]; },
    async ajouter(c, acteur, e) { appels.push(["ajouter", c, acteur, e]); return { ...note(N1, "2026-11-07T08:00:00Z"), type: e.type }; },
    async epingler(c, acteur, id, v) { appels.push(["epingler", c, acteur, id, v]); return { ...note(id, "2026-11-01T10:00:00Z"), epinglee: v }; },
    async noterAppelEtClore(c, acteur, e) { appels.push(["appel", c, acteur, e]); return o.alerteConnue === false ? null : { note: { ...note(N1, "2026-11-07T08:00:00Z"), type: "appel" }, alerte_close: true }; },
    async tracer(t) { traces.push(t); },
  };
  routeNotes(app, deps);
  return { app, appels, traces };
}
const base = (id: string) => `/api/console/v1/clients/${id}/notes`;

describe("notes de la fiche client", () => {
  it("[B-050] une note épinglée reste en tête, puis les plus récentes", async () => {
    expect(ordonnerNotes([note("a", "2026-11-01T10:00:00Z"), note("b", "2026-11-05T10:00:00Z"), note("c", "2026-10-01T10:00:00Z", true)]).map((n) => n.id)).toEqual(["c", "b", "a"]);
    const { app } = serveur();
    expect((await app.inject({ method: "GET", url: base(A) })).json().notes.map((n: Note) => n.id)).toEqual(["c", "b", "a"]);
  });

  it("[B-050] on ajoute une note, un appel ou un échange, et on épingle ; l'auteur vient de la session", async () => {
    const { app, appels } = serveur();
    expect((await app.inject({ method: "POST", url: base(A), payload: { type: "echange", texte: "Rappel prévu" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${base(A)}/${N1}/epingler`, payload: { epinglee: true } })).json().epinglee).toBe(true);
    expect(appels[0]).toEqual(["ajouter", A, "agent-essai", { type: "echange", texte: "Rappel prévu" }]);
    for (const payload of [{ type: "note", texte: "x", auteur: "autre" }, { type: "inconnu", texte: "x" }, { type: "note", texte: "  " }]) {
      expect((await app.inject({ method: "POST", url: base(A), payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("[B-103] noter l'appel clôt l'alerte d'un seul geste et se trace sans le texte de la note", async () => {
    const { app, appels, traces } = serveur();
    const rep = await app.inject({ method: "POST", url: `${base(A)}/appel-et-cloture`, payload: { texte: "Appelée, tout est réglé", alerte_id: ALERTE } });
    expect(rep.statusCode).toBe(201);
    expect(rep.json()).toMatchObject({ alerte_close: true, note: { type: "appel" } });
    expect(appels.filter((a) => a[0] === "appel")).toHaveLength(1);
    expect(traces).toEqual([{ acteur: "agent-essai", client: A, action: "noter_appel_clore_alerte", alerte_id: ALERTE, note_id: N1 }]);
  });

  it("[B-103] une alerte inconnue répond 404 et ne trace rien", async () => {
    const { app, traces } = serveur({ alerteConnue: false });
    expect((await app.inject({ method: "POST", url: `${base(A)}/appel-et-cloture`, payload: { texte: "x", alerte_id: ALERTE } })).statusCode).toBe(404);
    expect(traces).toEqual([]);
  });

  it("[B-126] @isolation des notes hors portée répondent 404 et rien n'est lu ni écrit", async () => {
    const { app, appels } = serveur();
    const requetes = [
      { method: "GET", url: base(B) },
      { method: "POST", url: base(B), payload: { type: "note", texte: "x" } },
      { method: "POST", url: `${base(B)}/${N1}/epingler`, payload: { epinglee: true } },
      { method: "POST", url: `${base(B)}/appel-et-cloture`, payload: { texte: "x", alerte_id: ALERTE } },
    ] as const;
    for (const r of requetes) expect((await app.inject(r)).statusCode, r.url).toBe(404);
    expect(appels).toEqual([]);
  });

  it("[B-050] l'interrupteur des notes est fermé par défaut : 503 et rien n'est appelé", async () => {
    const { app, appels } = serveur({ ouvert: false });
    expect((await app.inject({ method: "GET", url: base(A) })).statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: base(A), payload: { type: "note", texte: "x" } })).statusCode).toBe(503);
    expect(appels).toEqual([]);
  });
});
