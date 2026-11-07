import { describe, expect, it } from "vitest";
import { libelleRaison } from "./raisons.js";
import { SEUILS } from "./etat.js";

describe("raisons lisibles", () => {
  it("[B-391] chaque raison a une phrase simple, avec le seuil importé et non recopié", () => {
    expect(libelleRaison("succes_sous_80")).toContain("80");
    expect(libelleRaison("echecs_de_suite")).toContain(String(SEUILS.echecsDeSuite));
    expect(libelleRaison("connexion_expiree")).toMatch(/connexion/i);
  });
  it("[B-391] un code inconnu ne casse rien", () => {
    expect(libelleRaison("code_inconnu")).toBe("Raison non décrite");
  });
});
