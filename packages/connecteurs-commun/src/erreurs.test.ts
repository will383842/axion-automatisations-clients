import { describe, expect, it } from "vitest";
import { classer, ErreurConnecteur, journaliser } from "./erreurs.ts";
import { avecJeton, creerJeton } from "./jeton.ts";

describe("classes d'erreurs", () => {
  it("[A-406] une erreur réseau inattendue sort en definitive", () => {
    expect(classer(new TypeError("fetch failed")).classe).toBe("definitive");
    expect(classer(Object.assign(new Error("reset"), { code: "ECONNRESET" })).classe).toBe("definitive");
  });
  it("[A-406] une valeur lancée qui n'est pas une erreur sort aussi en definitive", () => {
    for (const v of ["boom", null, undefined, 42, { classe: "passagere" }]) expect(classer(v).classe).toBe("definitive");
  });
  it("[A-406] un quota sans date valide devient definitive", () => {
    expect(classer(new ErreurConnecteur("quota", "quota_depasse", { reprise: "pas une date" })).classe).toBe("definitive");
    expect(classer(new ErreurConnecteur("quota", "quota_depasse", {})).classe).toBe("definitive");
    expect(classer(new ErreurConnecteur("quota", "quota_depasse", { reprise: "2026-11-01T08:00:00Z" })).classe).toBe("quota");
  });
  it("[A-406] seules les 4 classes existent ; une classe inventée devient definitive", () => {
    expect(classer(new ErreurConnecteur("reessayer-sans-fin" as never, "x")).classe).toBe("definitive");
  });
  it("[A-406] journaliser refuse un champ « corps »", () => {
    expect(() => journaliser({ corps: "bonjour" })).toThrow(/corps/);
  });
  it("[A-406] journaliser refuse objet, adresse, jeton, variantes de casse et clés dangereuses", () => {
    for (const cle of ["objet", "adresse", "jeton", "Corps", "corps ", "__proto__", "constructor"]) {
      expect(() => journaliser(JSON.parse(`{"${cle}":"x"}`))).toThrow();
    }
  });
  it("[A-406] journaliser refuse une valeur qui n'est pas un identifiant ou un code", () => {
    expect(() => journaliser({ id: { corps: "x" } })).toThrow();
    expect(() => journaliser({ id: "a".repeat(500) })).toThrow();
    expect(() => journaliser({ id: "ligne\nforgée" })).toThrow();
  });
  it("[A-406] journaliser accepte les identifiants et les codes de la liste fermée", () => {
    expect(journaliser({ id: "m-1", code: "http_503", classe: "passagere", action: "lire" })).toBe(
      '{"id":"m-1","code":"http_503","classe":"passagere","action":"lire"}',
    );
  });
});

describe("jeton court", () => {
  it("[A-400] le jeton ne se laisse lire ni par texte, ni par JSON, ni par affichage", () => {
    const j = creerJeton("valeur-inventee-123", 10_000);
    expect(`${String(j)}${JSON.stringify(j)}`).not.toContain("valeur-inventee-123");
    expect(JSON.stringify(Object.entries(j))).not.toContain("valeur-inventee-123");
  });
  it("[A-400] un jeton expiré est refusé en identification, sans révéler sa valeur", () => {
    const j = creerJeton("valeur-inventee-123", 1000);
    expect(avecJeton(j, 999, (v) => v)).toBe("valeur-inventee-123");
    try {
      avecJeton(j, 1000, (v) => v);
      expect.unreachable();
    } catch (e) {
      expect((e as ErreurConnecteur).classe).toBe("identification");
      expect(String(e)).not.toContain("valeur-inventee-123");
    }
  });
  it("[A-400] une valeur de jeton vide ou une expiration absurde est refusée", () => {
    expect(() => creerJeton("", 10)).toThrow();
    expect(() => creerJeton("x", Number.NaN)).toThrow();
  });
});
