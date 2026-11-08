import { describe, expect, it } from "vitest";
import { ErreurKeycloak } from "./keycloak-admin.ts";
import { listerSessions, revoquerSession, type DepsSessions } from "./sessions.ts";

const M1 = "11111111-1111-4111-8111-111111111111";
const K1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S_AUTRE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T0 = Date.parse("2026-11-07T08:00:00Z");

function deps(sur: Partial<DepsSessions["keycloak"]> = {}) {
  const appels: string[] = [];
  const traces: unknown[] = [];
  const d: DepsSessions = {
    maintenant: () => T0 + 3_600_000,
    membres: { actifs: async () => [{ id: M1, sujet: K1, role: "dirigeant" }], actif: async (id) => (id === M1 ? { id: M1, sujet: K1, role: "dirigeant" } : undefined) },
    keycloak: {
      sessionsDe: async (u) => { appels.push(`sessionsDe ${u}`); return [{ id: S1, ouverteLe: T0, derniereActivite: T0 + 3_000_000 }]; },
      facteursDe: async () => ["otp"],
      fermerSession: async (s) => { appels.push(`fermer ${s}`); },
      ...sur,
    },
    trace: { revocation: async (e) => { traces.push(e); } },
  };
  return { d, appels, traces };
}

describe("sessions de l'équipe", () => {
  it("[B-026] la liste rend sessions, ouverture, fin prévue et facteurs de chaque membre actif, champs fermés", async () => {
    const { d } = deps();
    const r = await listerSessions(d);
    expect(r).toEqual([{
      membre_id: M1, role: "dirigeant", facteurs: ["otp"],
      sessions: [{ id: S1, ouverte_le: "2026-11-07T08:00:00.000Z", derniere_activite: "2026-11-07T08:50:00.000Z", fin_prevue: "2026-11-07T09:20:00.000Z" }],
    }]);
    // Aucune clé brute de Keycloak, ni l'identifiant Keycloak du membre.
    expect(JSON.stringify(r)).not.toContain(K1);
  });

  it("[B-026] la fin prévue est la plus proche de : ouverture + 8 h, dernière activité + 30 min", async () => {
    const { d } = deps({ sessionsDe: async () => [{ id: S1, ouverteLe: T0, derniereActivite: T0 + 8 * 3_600_000 - 60_000 }] });
    const [m] = await listerSessions(d);
    expect(m?.sessions[0]?.fin_prevue).toBe("2026-11-07T16:00:00.000Z");
  });

  it("[B-027] révoquer ferme la session dans Keycloak et se trace au journal", async () => {
    const { d, appels, traces } = deps();
    await revoquerSession(d, { acteur: "dirigeant-test", membreId: M1, sessionId: S1 });
    expect(appels).toEqual([`sessionsDe ${K1}`, `fermer ${S1}`]);
    expect(traces).toEqual([{ acteur: "dirigeant-test", membreId: M1, sessionId: S1 }]);
  });

  it("[B-027] révoquer une session qui n'appartient pas au membre visé rend 404 sans appel à Keycloak pour la fermer", async () => {
    const { d, appels, traces } = deps();
    await expect(revoquerSession(d, { acteur: "dirigeant-test", membreId: M1, sessionId: S_AUTRE })).rejects.toMatchObject({ code: "introuvable" });
    await expect(revoquerSession(d, { acteur: "dirigeant-test", membreId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionId: S1 })).rejects.toMatchObject({ code: "introuvable" });
    expect(appels.some((a) => a.startsWith("fermer"))).toBe(false);
    expect(traces).toEqual([]);
  });

  it("[B-027] une session déjà fermée rend 404 sans trace, et une panne de Keycloak rend 503 sans détail", async () => {
    const a = deps({ fermerSession: async () => { throw new ErreurKeycloak("introuvable", 404); } });
    await expect(revoquerSession(a.d, { acteur: "x", membreId: M1, sessionId: S1 })).rejects.toMatchObject({ code: "introuvable" });
    const b = deps({ fermerSession: async () => { throw new ErreurKeycloak("indisponible", 500); } });
    const e = await revoquerSession(b.d, { acteur: "x", membreId: M1, sessionId: S1 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "porte_fermee" });
    expect(String((e as Error).message)).not.toMatch(/keycloak|500/i);
    expect(b.traces).toEqual([]);
  });
});
