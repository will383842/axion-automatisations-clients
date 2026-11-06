import { describe, expect, it } from "vitest";
import { executerLecture, type ClientLecture } from "./executer.js";

// Faux client : note chaque texte reçu, dans l'ordre. `etat` : la connexion est libre, porte une transaction ouverte ou avortée (la sonde SAVEPOINT le dit).
const SONDE = "SAVEPOINT axion_sonde";
function faux(echec?: string, ro = "on", etat: "libre" | "ouverte" | "avortee" = "libre"): { client: ClientLecture; vus: string[] } {
  const vus: string[] = [];
  return { vus, client: { query: async (texte) => {
    vus.push(texte);
    if (texte === SONDE) {
      if (etat === "ouverte") return { rows: [] };
      throw Object.assign(new Error("sonde"), { code: etat === "avortee" ? "25P02" : "25P01" });
    }
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
    expect(vus).toEqual([SONDE, "BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT current_setting('transaction_read_only') AS ro", "SELECT 1", "COMMIT"]);
    expect(lignes).toEqual([{ n: 1 }]);
  });

  it("[A-170] executerLecture annule la transaction quand la requête échoue, puis rend l'erreur", async () => {
    const { client, vus } = faux("SELECT 1");
    await expect(executerLecture(client, { texte: "SELECT 1", valeurs: [1] }, { delaiMs: 250 })).rejects.toThrow("rejet");
    expect(vus).toEqual([SONDE, "BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT current_setting('transaction_read_only') AS ro", "SELECT 1", "ROLLBACK"]);
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
    expect(vus).toEqual([SONDE, "BEGIN READ ONLY", "SET LOCAL statement_timeout = 250", "SELECT current_setting('transaction_read_only') AS ro", "ROLLBACK"]);
  });

  it("[A-170] une liste de valeurs vide est refusée sans aucun envoi", async () => {
    for (const valeurs of [[], undefined, "x"] as unknown[]) {
      const { client, vus } = faux();
      await expect(executerLecture(client, { texte: "SELECT 1", valeurs: valeurs as unknown[] }, { delaiMs: 250 })).rejects.toThrow("valeurs");
      expect(vus).toEqual([]);
    }
  });

  it("[A-170] une transaction déjà ouverte par l'appelant est refusée AVANT BEGIN : rien d'autre n'est envoyé", async () => {
    const { client, vus } = faux(undefined, "on", "ouverte");
    const err = await executerLecture(client, SQL, { delaiMs: 250 }).catch((e) => e);
    expect(err).toMatchObject({ connexionPerdue: true });
    expect(vus).toEqual([SONDE]);
  });

  it("[A-170] une transaction avortée sur la connexion est rendue connexionPerdue, sans BEGIN ni requête", async () => {
    const { client, vus } = faux(undefined, "on", "avortee");
    await expect(executerLecture(client, SQL, { delaiMs: 250 })).rejects.toMatchObject({ connexionPerdue: true });
    expect(vus).toEqual([SONDE]);
  });

  it("[A-170] un BEGIN READ ONLY qui échoue est annulé, et un ROLLBACK qui échoue rend connexionPerdue", async () => {
    const a = faux("BEGIN READ ONLY");
    await expect(executerLecture(a.client, SQL, { delaiMs: 250 })).rejects.toThrow("rejet");
    expect(a.vus).toEqual([SONDE, "BEGIN READ ONLY", "ROLLBACK"]);
    const b = faux("BEGIN READ ONLY");
    const base = b.client.query;
    b.client.query = async (t, v) => { if (t === "ROLLBACK") throw new Error("coupé"); return base(t, v); };
    await expect(executerLecture(b.client, SQL, { delaiMs: 250 })).rejects.toMatchObject({ connexionPerdue: true });
  });
});
