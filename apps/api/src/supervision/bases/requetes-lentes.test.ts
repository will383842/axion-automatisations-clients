import { describe, expect, it } from "vitest";
import { compterLentes, SQL_REQUETES_LENTES, suiviAutorise } from "./requetes-lentes.js";

describe("requêtes lentes", () => {
  it("[A-197] une requête lente fictive est comptée, son texte n'est pas rangé", () => {
    const lignes = [
      { queryid: "111", calls: 10, mean_exec_time: 850, query: "SELECT * FROM clients WHERE email = 'x@exemple.fr'" },
      { queryid: "222", calls: 5, mean_exec_time: 20, query: "SELECT 1" },
    ];
    const r = compterLentes(lignes, 500);
    expect(r).toEqual({ nombre: 1, identifiants: ["111"] });
    expect(JSON.stringify(r)).not.toContain("exemple.fr");
  });

  it("[A-197] la requête SQL ne lit jamais la colonne query", () => {
    expect(SQL_REQUETES_LENTES).toMatch(/queryid/);
    expect(SQL_REQUETES_LENTES).not.toMatch(/\bquery\b/);
  });

  it("[A-197] sans suivi des requêtes (track = none) la relève refuse de compter", () => {
    expect(suiviAutorise("none")).toBe(false);
    expect(suiviAutorise("top")).toBe(true);
    expect(() => compterLentes([], 500, "none")).toThrow(/suivi/);
  });
});
