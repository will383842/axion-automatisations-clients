import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { exigerJeton } from "../../auth/oidc.ts";
import { exigerReauthentification } from "../../auth/exiger-reauthentification.ts";
import type { DepsDroits, MembreDroits, TraceRefus } from "../../droits/exiger-droit.ts";
import { brancherErreurs } from "../../plugins/erreurs.js";
import { routeSessions, type DepsRoutesSessions } from "./sessions.ts";

const M = "11111111-1111-4111-8111-111111111111";
const S = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MAINTENANT = Date.parse("2026-11-07T10:00:00Z");
const URL_LISTE = "/api/console/v1/equipe/sessions";
const URL_REVOQUER = `/api/console/v1/equipe/membres/${M}/sessions/${S}/revoquer`;
const dirigeant: MembreDroits = { sujet: "dirigeant-test", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } };
const second: MembreDroits = { sujet: "second-test", role: "second_administrateur", actif: true, portee: { clients: [], automatisations: [] } };

function monter(o: { membre?: MembreDroits; ouvert?: boolean; identite?: Record<string, unknown> } = {}) {
  const appels: string[] = [];
  const traces: TraceRefus[] = [];
  const droits: DepsDroits = { membre: async () => o.membre ?? dirigeant, absenceOuverte: async () => false, tracer: async (e) => { traces.push(e); } };
  const identite = { sub: "k", auth_time: Math.floor(MAINTENANT / 1000) - 60, acr: "mfa", ...o.identite };
  const d: DepsRoutesSessions = {
    ouvert: o.ouvert ?? true,
    exigerJeton: exigerJeton(async () => identite),
    exigerReauthentification: exigerReauthentification(() => MAINTENANT),
    droits,
    sessions: {
      maintenant: () => MAINTENANT,
      membres: { actifs: async () => { appels.push("membres"); return []; }, actif: async () => { appels.push("membre"); return { id: M, sujet: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "dirigeant" }; } },
      keycloak: {
        sessionsDe: async () => { appels.push("sessionsDe"); return [{ id: S, ouverteLe: MAINTENANT, derniereActivite: MAINTENANT }]; },
        facteursDe: async () => [],
        fermerSession: async () => { appels.push("fermer"); },
      },
      trace: { revocation: async () => { appels.push("trace"); } },
    },
    acces: { lister: async () => { appels.push("acces"); return []; } },
  };
  const app = Fastify();
  brancherErreurs(app);
  routeSessions(app, d);
  return { app, appels, traces };
}
const AVEC = { authorization: "Bearer a.b.c" };

describe("routes de sécurité : sessions", () => {
  it("[B-026] la liste rend membres, sessions et accès en cours pour un dirigeant", async () => {
    const { app } = monter();
    const r = await app.inject({ url: URL_LISTE, headers: AVEC });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(["acces_en_cours", "membres"]);
  });

  it("[B-027] révoquer ferme la session puis rend 204", async () => {
    const { app, appels } = monter();
    const r = await app.inject({ method: "POST", url: URL_REVOQUER, headers: AVEC });
    expect(r.statusCode).toBe(204);
    expect(appels).toEqual(["membre", "sessionsDe", "fermer", "trace"]);
  });

  it("[B-027] des identifiants qui ne sont pas des UUID rendent 400 avant tout appel", async () => {
    const { app, appels } = monter();
    for (const url of ["/api/console/v1/equipe/membres/x/sessions/y/revoquer", `/api/console/v1/equipe/membres/${M}/sessions/..%2Fclients/revoquer`]) {
      const r = await app.inject({ method: "POST", url, headers: AVEC });
      expect(r.statusCode, url).toBe(400);
    }
    expect(appels).toEqual([]);
  });

  it("[C-003] révoquer sans réauthentification récente rend 401 reauthentification_requise sans appel", async () => {
    for (const identite of [{ auth_time: Math.floor(MAINTENANT / 1000) - 301 }, { acr: "1" }]) {
      const { app, appels } = monter({ identite });
      const r = await app.inject({ method: "POST", url: URL_REVOQUER, headers: AVEC });
      expect(r.statusCode).toBe(401);
      expect(r.json().erreur.code).toBe("reauthentification_requise");
      expect(appels).toEqual([]);
    }
  });

  it("[LOT3-securite] un second administrateur reçoit 403 sur chaque route de sécurité, et le refus est tracé", async () => {
    const { app, appels, traces } = monter({ membre: second });
    const a = await app.inject({ url: URL_LISTE, headers: AVEC });
    const b = await app.inject({ method: "POST", url: URL_REVOQUER, headers: AVEC });
    expect([a.statusCode, b.statusCode]).toEqual([403, 403]);
    expect(traces.map((t) => [t.action, t.sujet, t.motif])).toEqual([["utilisateurs_roles", "second-test", "droit_refuse"], ["utilisateurs_roles", "second-test", "droit_refuse"]]);
    expect(appels).toEqual([]);
  });

  it("[LOT3-securite] un cookie sans en-tête Authorization rend 401 sur chaque geste", async () => {
    const { app, appels } = monter();
    const cookie = { cookie: "session=abc; csrf=def" };
    const a = await app.inject({ url: URL_LISTE, headers: cookie });
    const b = await app.inject({ method: "POST", url: URL_REVOQUER, headers: cookie });
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(appels).toEqual([]);
  });

  it("[LOT3-securite] la porte fermée rend 503 sur chaque route", async () => {
    const { app, appels } = monter({ ouvert: false });
    const a = await app.inject({ url: URL_LISTE, headers: AVEC });
    const b = await app.inject({ method: "POST", url: URL_REVOQUER, headers: AVEC });
    expect([a.statusCode, b.statusCode]).toEqual([503, 503]);
    expect(a.json().erreur.code).toBe("porte_fermee");
    expect(appels).toEqual([]);
  });
});
