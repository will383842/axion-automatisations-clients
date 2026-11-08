import { describe, expect, it } from "vitest";
import { depotSqlRegles, reglerRegle, type DepotRegles } from "./regles.js";

const RID = "bbbbbbbb-0000-4000-8000-000000000001";

describe("règles d'alertes (T5-04c)", () => {
  it("[B-031] la requête ne touche que gravité, seuil, fenêtre et activation, avec valeurs liées et sans texte du client", async () => {
    const vues: { texte: string; params: unknown[] }[] = [];
    const depot = depotSqlRegles(async (acteur, fn) => {
      expect(acteur).toBe("membre-1");
      return fn({ query: async (texte: string, params: unknown[]) => (vues.push({ texte, params }), { rows: [{ id: RID, code: "sante_orange", gravite: "critique", seuil: 5, fenetre_s: 300, active: true }] }) });
    });
    const r = await depot.regler(RID, { gravite: "critique", seuil: 5 }, "membre-1");
    expect(r?.gravite).toBe("critique");
    expect(vues).toHaveLength(1);
    expect(vues[0]!.texte).toMatch(/^UPDATE regles_alertes SET gravite = \$2, seuil = \$3 WHERE id = \$1 RETURNING /);
    expect(vues[0]!.params).toEqual([RID, "critique", 5]);
    expect(vues[0]!.texte).not.toMatch(/\bcode\s*=/);
  });

  it("[B-031] une règle inconnue rend null ; une valeur négative ou un champ inconnu est refusé avant toute requête", async () => {
    const depot = depotSqlRegles(async (_a, fn) => fn({ query: async () => ({ rows: [] }) }));
    expect(await depot.regler(RID, { seuil: 1 }, "m")).toBeNull();
    let appels = 0;
    const faux: DepotRegles = { async regler() { appels++; return null; } };
    await expect(reglerRegle(faux, RID, { seuil: -1 }, "m")).rejects.toThrow("valeur_invalide");
    await expect(reglerRegle(faux, RID, { fenetre_s: 0 }, "m")).rejects.toThrow("valeur_invalide");
    await expect(reglerRegle(faux, RID, { code: "x" } as never, "m")).rejects.toThrow("champ_inconnu");
    await expect(reglerRegle(faux, RID, {}, "m")).rejects.toThrow("champ_inconnu");
    expect(appels).toBe(0);
  });
});
