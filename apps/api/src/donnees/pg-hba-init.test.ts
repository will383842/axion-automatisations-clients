import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Garde rapide (sans Docker) : une virgule dans un jeton pg_hba coupe l'expression et PostgreSQL refuse de démarrer.
const init = readFileSync(fileURLToPath(new URL("../../../../ops/socle/donnees/init.sql", import.meta.url)), "utf8");
const regles = [...init.matchAll(/^\s*'((?:local|host)\s[^']*)'/gm)].map((m) => m[1]!);

describe("règles pg_hba de init.sql", () => {
  it("[A-219] trouve les règles « local » du tableau", () => {
    expect(regles.filter((r) => r.startsWith("local ")).length).toBeGreaterThanOrEqual(5);
  });

  it("[A-219] les règles « local » ont 4 champs séparés par des espaces", () => {
    for (const r of regles.filter((l) => l.startsWith("local "))) expect({ r, champs: r.split(" ").length }).toEqual({ r, champs: 4 });
  });

  it("[A-219] aucun jeton d'une règle ne contient de virgule hors guillemets", () => {
    for (const r of regles) {
      let guillemets = false;
      let virgule = false;
      for (const c of r) {
        if (c === '"') guillemets = !guillemets;
        else if (c === "," && !guillemets) virgule = true;
      }
      expect({ r, virgule }).toEqual({ r, virgule: false });
    }
  });
});
