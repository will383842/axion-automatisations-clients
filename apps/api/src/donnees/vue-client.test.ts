import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { accordValideSql, ouvrirVueClient, type DepsVue } from "./vue-client.js";
import type { SessionDonnees } from "./service.js";

const A = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-11-02T10:00:00Z");
const equipe: SessionDonnees = { tenantId: A, role: "equipe", acteur: "e1", etablissements: [] };
function deps(accord: boolean, tracerEchoue = false) {
  const traces: Record<string, unknown>[] = [];
  const d: DepsVue = { accordValide: async () => accord, tracer: async (e) => { if (tracerEchoue) throw new Error("journal"); traces.push(e as never); }, finIntervention: async () => new Date(T0.getTime() + 7_200_000), ranger: () => {}, maintenant: () => T0 };
  return { d, traces };
}
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ErreurApi).code;

describe("vue « comme le client »", () => {
  it("[A-005] la vue exige un accord valide, sinon action interdite et rien n'est tracé", async () => {
    const { d, traces } = deps(false);
    expect(await code(ouvrirVueClient(d, equipe, A, "assistance"))).toBe("action_interdite");
    expect(traces).toEqual([]);
  });

  it("[A-005] la vue dure 60 minutes exactement, est tracée avec son motif et visible du client", async () => {
    const { d, traces } = deps(true);
    const s = await ouvrirVueClient(d, equipe, A, "assistance sur une liste");
    expect(s.vue).toEqual({ tenantId: A, expireLe: new Date(T0.getTime() + 3_600_000) });
    expect(traces).toEqual([{ tenantId: A, acteur: "e1", action: "vue_client_ouverte", motif: "assistance sur une liste", expireLe: s.vue!.expireLe, visibleDuClient: true }]);
  });

  it("[A-005] un client, un motif vide, un identifiant invalide ou un journal en panne n'ouvrent pas la vue", async () => {
    const { d } = deps(true);
    expect(await code(ouvrirVueClient(d, { ...equipe, role: "client" }, A, "x"))).toBe("action_interdite");
    expect(await code(ouvrirVueClient(d, equipe, A, "   "))).toBe("schema_invalide");
    expect(await code(ouvrirVueClient(d, equipe, "pas-un-uuid", "x"))).toBe("schema_invalide");
    expect(await code(ouvrirVueClient(deps(true, true).d, equipe, A, "x"))).toBe("erreur_interne");
  });

  it("[A-005] l'accord se cherche pour CE client seulement, à l'instant présent", async () => {
    const vus: unknown[][] = [];
    const ok = await accordValideSql({ requete: async (t, v) => { vus.push([t, v]); return [{ ok: 1 }]; } })(A, T0);
    expect(ok).toBe(true);
    expect(vus[0]![0]).toMatch(/visibilite_acces/);
    expect(vus[0]![1]).toEqual([A, T0]);
    expect(await accordValideSql({ requete: async () => [] })(A, T0)).toBe(false);
  });

  it("[A-005] la vue s'arrête à la fin de l'intervention si elle tombe avant les 60 minutes", async () => {
    const fin = new Date(T0.getTime() + 600_000);
    const { d } = deps(true);
    const s = await ouvrirVueClient({ ...d, finIntervention: async () => fin }, equipe, A, "assistance");
    expect(s.vue!.expireLe).toEqual(fin);
    const loin = new Date(T0.getTime() + 7_200_000);
    expect((await ouvrirVueClient({ ...d, finIntervention: async () => loin }, equipe, A, "assistance")).vue!.expireLe).toEqual(new Date(T0.getTime() + 3_600_000));
  });
});
