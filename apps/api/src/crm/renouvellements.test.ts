import { describe, expect, it } from "vitest";
import { signalerRenouvellementsProches } from "./renouvellements.ts";

const T = "11111111-1111-4111-8111-111111111111";
describe("tâche de nuit : renouvellements à 30 jours", () => {
  it("[C-346] renouvellement.proche part pour chaque abonnement qui se renouvelle dans 30 jours, une fois par date", async () => {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const client = { query: async (texte: string, valeurs: unknown[] = []) => (requetes.push({ texte, valeurs }), { rows: [{ date_renouvellement: "2026-11-23" }, { date_renouvellement: "2026-11-23" }], rowCount: 2 }) };
    const faits: unknown[][] = [];
    const emetteur = { renouvellementProche: async (...a: unknown[]) => void faits.push(a) };
    const n = await signalerRenouvellementsProches(client, emetteur as never, T, "2026-10-24");
    expect(n).toBe(1);
    expect(requetes[0]?.valeurs).toEqual([T, "2026-11-23"]);
    expect(faits).toHaveLength(1);
    expect(faits[0]?.[0]).toMatchObject({ id: "renouvellement:2026-11-23" });
    expect(faits[0]?.slice(1)).toEqual([T, "2026-11-23"]);
  });
});
