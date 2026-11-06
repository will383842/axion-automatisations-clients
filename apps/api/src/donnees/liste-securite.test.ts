import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLONNES_CHIFFREES, LISTE_BLANCHE, numerosCoherents, verifierListeBlanche } from "./requetes/liste.js";

// Colonnes chiffrées lues dans le MODÈLE (T2-37c). Les attaques sur le texte SQL des tours 1 à 5 sont remplacées par requetes/structure-securite.test.ts : plus aucun texte SQL n'entre.
describe("liste blanche : colonnes chiffrées", () => {
  it("[B-172] la liste fermée des colonnes chiffrées vient du modèle SQL, empreintes comprises", () => {
    const modele = readFileSync(fileURLToPath(new URL("../../drizzle-cli/0000_modele_base_client.sql", import.meta.url)), "utf8");
    const binaires = [...modele.matchAll(/^\s*"([a-z_]+)" "bytea"/gm)].map((m) => m[1]!);
    expect(binaires.length).toBeGreaterThan(0);
    for (const c of binaires) expect(COLONNES_CHIFFREES.has(c), c).toBe(true);
    for (const c of ["courriel_chiffre", "courriel_empreinte", "telephone_chiffre", "telephone_empreinte", "empreinte"]) expect(COLONNES_CHIFFREES.has(c), c).toBe(true);
  });

  it("[B-172] la liste blanche livrée ne rend, ne filtre et ne trie aucune colonne chiffrée", () => {
    const livree = JSON.stringify(Object.values(LISTE_BLANCHE).map((r) => [r.forme, r.variantes]));
    for (const c of COLONNES_CHIFFREES) expect(livree, c).not.toContain(`"${c}"`);
    expect(() => verifierListeBlanche(LISTE_BLANCHE)).not.toThrow();
  });
});

describe("accord des numéros $n et des valeurs, à la déclaration", () => {
  it("[B-173] verifierListeBlanche refuse à la déclaration une requête dont les $n ne correspondent pas aux valeurs", () => {
    expect(numerosCoherents({ texte: "SELECT 1 WHERE a = $1 AND b = $2", valeurs: [1, 2] })).toBe(true);
    expect(numerosCoherents({ texte: "SELECT 1", valeurs: [] })).toBe(true);
    expect(numerosCoherents({ texte: "SELECT 1 WHERE a = $1 AND b = $3", valeurs: [1, 2] })).toBe(false);
    expect(numerosCoherents({ texte: "SELECT 1 WHERE a = $1", valeurs: [1, 2] })).toBe(false);
    expect(numerosCoherents({ texte: "SELECT 1 WHERE a = $2", valeurs: [1] })).toBe(false);
    expect(numerosCoherents({ texte: "SELECT 1 WHERE a = $0", valeurs: [1] })).toBe(false);
    expect(() => verifierListeBlanche({})).not.toThrow();
  });
});
