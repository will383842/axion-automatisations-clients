import { describe, expect, it } from "vitest";
import { executerLecture, type ClientLecture } from "./executer.js";

// Faux client : note chaque texte reçu, dans l'ordre.
function faux(echec?: string, ro = "on"): { client: ClientLecture; vus: string[] } {
  const vus: string[] = [];
  return { vus, client: { query: async (texte) => {
    vus.push(texte);
    if (texte === echec) throw new Error("rejet");
    if (texte.startsWith("SELECT current_setting")) return { rows: [{ ro }] };
    return { rows: [{ n: 1 }] };
  } } };
}
const SQL = { texte: "SELECT 1", valeurs: [1] as unknown[] };

describe("executerLecture", () => {
  it("[A-170] executerLecture envoie BEGIN READ ONLY, le délai, la requête puis COMMIT, dans cet ordre", async () => {
    const { client, vus } = faux();
    const lignes = await executerLecture(client, { texte: "SELECT 1", valeurs: [1] }, { delaiMs: 250 });
    expect(vus).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT current_setting('transaction_read_only') AS ro", "SELECT 1", "COMMIT"]);
    expect(lignes).toEqual([{ n: 1 }]);
  });

  it("[A-170] executerLecture annule la transaction quand la requête échoue, puis rend l'erreur", async () => {
    const { client, vus } = faux("SELECT 1");
    await expect(executerLecture(client, { texte: "SELECT 1", valeurs: [1] }, { delaiMs: 250 })).rejects.toThrow("rejet");
    expect(vus).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT current_setting('transaction_read_only') AS ro", "SELECT 1", "ROLLBACK"]);
  });

  it("[A-170] executerLecture refuse un délai illisible avant tout envoi", async () => {
    for (const delaiMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 600_001, "5; DROP" as unknown as number]) {
      const { client, vus } = faux();
      await expect(executerLecture(client, { texte: "SELECT 1", valeurs: [1] }, { delaiMs }), String(delaiMs)).rejects.toThrow("délai");
      expect(vus).toEqual([]);
    }
  });

  it("[A-170] un ROLLBACK en échec rend une erreur connexionPerdue", async () => {
    const { client } = faux("SELECT 1");
    const base = client.query;
    client.query = async (t, v) => { if (t === "ROLLBACK") throw new Error("coupé"); return base(t, v); };
    const err = await executerLecture(client, SQL, { delaiMs: 250 }).catch((e) => e);
    expect(err).toMatchObject({ connexionPerdue: true });
    expect(err.cause).toMatchObject({ message: "rejet" });
    expect(err.message).not.toMatch(/SELECT|SET|BEGIN/);
  });

  it("[A-170] une transaction déjà ouverte est refusée avant la requête", async () => {
    const { client, vus } = faux(undefined, "off");
    await expect(executerLecture(client, SQL, { delaiMs: 250 })).rejects.toMatchObject({ connexionPerdue: true });
    expect(vus).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT current_setting('transaction_read_only') AS ro", "ROLLBACK"]);
  });

  it("[A-170] une liste de valeurs vide est refusée sans aucun envoi", async () => {
    for (const valeurs of [[], undefined, "x"] as unknown[]) {
      const { client, vus } = faux();
      await expect(executerLecture(client, { texte: "SELECT 1", valeurs: valeurs as unknown[] }, { delaiMs: 250 })).rejects.toThrow("valeurs");
      expect(vus).toEqual([]);
    }
  });
});
