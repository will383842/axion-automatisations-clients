import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { genererSql } from "./generer.js";
import { premieresRequetes } from "./premieres.js";
import { schemaParametres } from "./structure.js";

// Test d'or du déplacement du générateur (T4-50b) : sql-or.json a été pris sur main AVANT tout déplacement et ne se régénère jamais.
interface Cas { requete: string; parametres: Record<string, unknown>; etablissements: string[]; texte: string; valeurs: unknown[]; colonnes: string[] }
const or = JSON.parse(readFileSync(fileURLToPath(new URL("./sql-or.json", import.meta.url)), "utf8")) as Cas[];

describe("test d'or du générateur", () => {
  it("[A-170] le SQL produit pour chaque requête de premieres.ts est identique à celui d'avant le déplacement", () => {
    const livrees = premieresRequetes();
    expect(new Set(or.map((c) => c.requete))).toEqual(new Set(Object.keys(livrees)));
    expect(or.length).toBeGreaterThanOrEqual(15);
    for (const c of or) {
      const r = livrees[c.requete]!;
      expect(genererSql(r, schemaParametres(r).parse(c.parametres) as Record<string, unknown>, c.etablissements), c.requete).toEqual({ texte: c.texte, valeurs: c.valeurs, colonnes: c.colonnes });
    }
  });
});
