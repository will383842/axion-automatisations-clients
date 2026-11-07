import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { brancherErreurs } from "../../apps/api/src/plugins/erreurs.js";
import { routeSessions } from "../../apps/api/src/routes/equipe/sessions.js";

// Routes de sécurité de l'équipe : aucune donnée de client en entrée. Une session de client (ou d'un autre royaume) est refusée comme une session absente,
// et aucune dépendance de fermeture n'est appelée.
const M = "11111111-1111-4111-8111-111111111111";
const S_CLIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const S_MEMBRE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const passe = (async () => undefined) as never;
function app(appels: string[]) {
  const a = Fastify();
  brancherErreurs(a);
  routeSessions(a, {
    ouvert: true, exigerJeton: passe, exigerReauthentification: passe,
    droits: { membre: async () => ({ sujet: "dirigeant-test", role: "dirigeant" as const, actif: true, portee: { clients: [], automatisations: [] } }), absenceOuverte: async () => false, tracer: async () => undefined },
    sessions: {
      maintenant: () => 0,
      membres: { actifs: async () => [], actif: async () => ({ id: M, sujet: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "dirigeant" }) },
      keycloak: { sessionsDe: async () => [{ id: S_MEMBRE, ouverteLe: 0, derniereActivite: 0 }], facteursDe: async () => [], fermerSession: async (s) => { appels.push(`fermer ${s}`); } },
      trace: { revocation: async () => { appels.push("trace"); } },
    },
    acces: { lister: async () => [] },
  });
  return a;
}
describe("sécurité de l'équipe : mauvais client", () => {
  it("[C-536] @isolation GET /api/console/v1/equipe/sessions", async () => {
    const r = await app([]).inject({ url: "/api/console/v1/equipe/sessions" });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(S_CLIENT);
  });
  it("[C-536] @isolation POST /api/console/v1/equipe/membres/:id/sessions/:session/revoquer", async () => {
    const appels: string[] = [];
    const inconnue = await app(appels).inject({ method: "POST", url: `/api/console/v1/equipe/membres/${M}/sessions/${S_CLIENT}/revoquer` });
    const absente = await app(appels).inject({ method: "POST", url: `/api/console/v1/equipe/membres/${S_CLIENT}/sessions/${S_CLIENT}/revoquer` });
    expect(inconnue.statusCode).toBe(404);
    const sansTrace = (t: string) => t.replace(/"id_trace":"[^"]*"/, "");
    expect(sansTrace(absente.body)).toBe(sansTrace(inconnue.body));
    expect(appels).toEqual([]);
  });
});
