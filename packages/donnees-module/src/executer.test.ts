import { describe, expect, it } from "vitest";
import { executerLecture, type ClientLecture } from "./executer.js";

// Faux client : note chaque texte reçu, dans l'ordre.
function faux(echec?: string): { client: ClientLecture; vus: string[] } {
  const vus: string[] = [];
  return { vus, client: { query: async (texte) => { vus.push(texte); if (texte === echec) throw new Error("rejet"); return { rows: [{ n: 1 }] }; } } };
}

describe("executerLecture", () => {
  it("[A-170] executerLecture envoie BEGIN READ ONLY, le délai, la requête puis COMMIT, dans cet ordre", async () => {
    const { client, vus } = faux();
    const lignes = await executerLecture(client, { texte: "SELECT 1", valeurs: [] }, { delaiMs: 250 });
    expect(vus).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT 1", "COMMIT"]);
    expect(lignes).toEqual([{ n: 1 }]);
  });

  it("[A-170] executerLecture annule la transaction quand la requête échoue, puis rend l'erreur", async () => {
    const { client, vus } = faux("SELECT 1");
    await expect(executerLecture(client, { texte: "SELECT 1", valeurs: [] }, { delaiMs: 250 })).rejects.toThrow("rejet");
    expect(vus).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT 1", "ROLLBACK"]);
  });

  it("[A-170] executerLecture refuse un délai illisible avant tout envoi", async () => {
    for (const delaiMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 600_001, "5; DROP" as unknown as number]) {
      const { client, vus } = faux();
      await expect(executerLecture(client, { texte: "SELECT 1", valeurs: [] }, { delaiMs }), String(delaiMs)).rejects.toThrow("délai");
      expect(vus).toEqual([]);
    }
  });
});
