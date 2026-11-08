import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { creerAccesInterventions } from "./acces-en-cours.ts";

const T = "11111111-1111-4111-8111-111111111111";
describe("accès en cours", () => {
  it("[B-026] la liste rend les interventions en cours lues dans visibilite_acces", async () => {
    const requetes: string[] = [];
    const client = {
      query: async (texte: string) => {
        requetes.push(texte);
        return texte.includes("visibilite_acces")
          ? { rows: [{ tenant_id: T, intervention_debut: new Date("2026-11-07T08:00:00Z"), intervention_fin: new Date("2026-11-07T10:00:00Z") }] }
          : { rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const r = await creerAccesInterventions(pool).lister();
    expect(r).toEqual([{ type: "intervention", clientId: T, debut: "2026-11-07T08:00:00.000Z", fin: "2026-11-07T10:00:00.000Z" }]);
    const lecture = requetes.find((q) => q.includes("visibilite_acces")) ?? "";
    expect(lecture).toMatch(/intervention_fin\s*>\s*now\(\)/);
    expect(requetes[0]).toMatch(/READ ONLY/);
    expect(requetes.join(" ")).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});
