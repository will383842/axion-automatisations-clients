import { describe, expect, it } from "vitest";
import { balayerRenouvellements } from "./planifier-renouvellements.js";

describe("tâche planifiée de renouvellement", () => {
  it("[A-057] ne renouvelle que les connexions proches de l'expiration et continue après une panne", async () => {
    const vues: string[] = [];
    const bilan = await balayerRenouvellements({
      connexions: async () => ["c1", "c2", "c3"],
      renouveler: async (id) => { vues.push(id); if (id === "c2") throw new Error("panne"); },
      journal: { tracer: () => undefined },
    });
    expect(vues).toEqual(["c1", "c2", "c3"]);
    expect(bilan).toEqual({ essayees: 3, echecs: 1 });
  });
});
