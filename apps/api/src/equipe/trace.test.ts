import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { creerTraceSessions } from "./trace.ts";

const M = "11111111-1111-4111-8111-111111111111";
const S = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function faux() {
  const appels: { texte: string; valeurs: unknown[] | undefined }[] = [];
  const client = { query: async (texte: string, valeurs?: unknown[]) => { appels.push({ texte, valeurs }); return { rows: [] }; }, release: () => undefined };
  return { appels, pool: { connect: async () => client } as unknown as Pool };
}
describe("trace des sessions", () => {
  it("[B-027] la révocation s'écrit par audit_ajouter sans client, avec le seul geste et le membre", async () => {
    const { appels, pool } = faux();
    await creerTraceSessions(pool).revocation({ acteur: "dirigeant-test", membreId: M, sessionId: S });
    const ajout = appels.find((a) => a.texte.includes("audit_ajouter"));
    expect(ajout?.valeurs).toEqual([null, "dirigeant-test", "modification", "session_equipe", S, JSON.stringify({ geste: "revocation", membre_id: M })]);
    expect(appels.map((a) => a.texte)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
  });
  it("[B-027] un acteur invalide ou un identifiant hors motif UUID n'écrit rien", async () => {
    const { appels, pool } = faux();
    await expect(creerTraceSessions(pool).revocation({ acteur: "  ", membreId: M, sessionId: S })).rejects.toThrow();
    await expect(creerTraceSessions(pool).revocation({ acteur: "x", membreId: M, sessionId: "../clients" })).rejects.toThrow();
    expect(appels).toEqual([]);
  });
});
