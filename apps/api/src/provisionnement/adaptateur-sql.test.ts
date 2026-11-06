import { describe, expect, it } from "vitest";
import { sqlPg } from "./adaptateur-sql.js";

describe("adaptateur Sql du provisionneur", () => {
  it("[A-216] un texte à plusieurs ordres part sans valeurs (protocole simple), sinon le serveur le refuse", async () => {
    const vus: { texte: string; valeurs?: unknown[] }[] = [];
    const sql = sqlPg({ query: async (texte: string, valeurs?: unknown[]) => { vus.push({ texte, ...(valeurs ? { valeurs } : {}) }); return { rows: [{ ok: 1 }] }; } });
    expect(await sql.requete("SET ROLE a; REVOKE ALL ON DATABASE b FROM PUBLIC; RESET ROLE")).toEqual([{ ok: 1 }]);
    expect(vus[0]).toEqual({ texte: "SET ROLE a; REVOKE ALL ON DATABASE b FROM PUBLIC; RESET ROLE" });
  });
  it("[A-216] une requête à valeurs garde le protocole étendu (les valeurs ne sont jamais collées au texte)", async () => {
    const vus: unknown[][] = [];
    const sql = sqlPg({ query: async (_t: string, v?: unknown[]) => { vus.push(v ?? []); return { rows: [] }; } });
    await sql.requete("SELECT quote_ident($1)", ["x"]);
    expect(vus).toEqual([["x"]]);
  });
  it("[A-216] un texte à plusieurs ordres avec des valeurs est refusé avant d'être envoyé", async () => {
    const sql = sqlPg({ query: async () => ({ rows: [] }) });
    await expect(sql.requete("SELECT $1; SELECT 2", ["x"])).rejects.toThrow("plusieurs ordres");
  });
});
