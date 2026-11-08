import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creerDepotConnexions } from "./depot.js";

const T = "11111111-1111-4111-8111-111111111111";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTEUR = "agent-essai";

// Faux pool : enregistre les requêtes passées à la transaction du client actif (avecClient).
function faux(rowCount = 1) {
  const requetes: { texte: string; valeurs: unknown[] }[] = [];
  const client = { query: async (texte: string, valeurs: unknown[] = []) => (requetes.push({ texte, valeurs }), { rows: [{ ok: 1 }], rowCount }), release: () => undefined };
  return { requetes, pool: { connect: async () => client } as never };
}
const metier = (r: { texte: string; valeurs: unknown[] }[]) => r.filter((q) => !/^(BEGIN|COMMIT|SELECT set_config)/.test(q.texte));

describe("dépôt SQL des connexions", () => {
  it("[B-092] la réclamation est un UPDATE conditionnel (a_tester ET jamais testée) qui doit toucher une ligne", async () => {
    const un = faux(1);
    expect(await creerDepotConnexions(un.pool).reclamer(T, C, ACTEUR)).toBe(true);
    const sql = metier(un.requetes)[0]!.texte;
    expect(sql).toMatch(/UPDATE connexions/);
    expect(sql).toMatch(/etat = 'a_tester'/);
    expect(sql).toMatch(/dernier_test_le IS NULL/);
    expect(metier(un.requetes)[0]!.valeurs).toEqual([T, C]);
    expect(await creerDepotConnexions(faux(0).pool).reclamer(T, C, ACTEUR)).toBe(false);
  });

  it("[A-393] mettre en pause ne vise que les instances actives liées à CETTE connexion (liaison non déliée)", async () => {
    const un = faux(2);
    expect(await creerDepotConnexions(un.pool).mettreEnPause(T, C, ACTEUR)).toBe(2);
    const sql = metier(un.requetes)[0]!.texte;
    expect(sql).toMatch(/UPDATE instances SET etat = 'pause'/);
    expect(sql).toMatch(/etat = 'active'/);
    expect(sql).toMatch(/connexions_instances/);
    expect(sql).toMatch(/delie_le IS NULL/);
  });

  it("[A-393] le dépôt ne détruit rien et ne touche aucune table de cli_<id>", () => {
    const source = readFileSync(new URL("./depot.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/cli_|DELETE|DROP|TRUNCATE/i);
  });

  it("[A-393] un acteur absent, vide ou de contrôle est refusé avant toute requête", async () => {
    const un = faux();
    const depot = creerDepotConnexions(un.pool);
    await expect(depot.marquerRevoquee(T, C, "", "demande_client")).rejects.toThrow();
    await expect(depot.marquerRevoquee(T, C, "a\nb", "demande_client")).rejects.toThrow();
    expect(un.requetes).toEqual([]);
  });
});
