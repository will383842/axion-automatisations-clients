import { describe, expect, it } from "vitest";
import { CODES_CONNEXION_EXPIREE, estConnexionExpiree } from "./connexion-expiree.js";

describe("connexion expirée", () => {
  it("[B-385] code invalid_grant de Microsoft 365 → connexion expirée", () => {
    expect(estConnexionExpiree("invalid_grant")).toBe(true);
  });
  it("[B-385] la liste des codes est fermée", () => {
    expect([...CODES_CONNEXION_EXPIREE].sort()).toEqual(["connexion_expiree", "connexion_rouge", "invalid_grant"]);
  });
  it("[B-385] un texte libre ou un autre code n'est jamais reconnu", () => {
    expect(estConnexionExpiree("la connexion de jean@exemple.fr a expiré")).toBe(false);
    expect(estConnexionExpiree("INVALID_GRANT")).toBe(false);
    expect(estConnexionExpiree("delai_depasse")).toBe(false);
    expect(estConnexionExpiree(null)).toBe(false);
    expect(estConnexionExpiree(undefined)).toBe(false);
  });
});
