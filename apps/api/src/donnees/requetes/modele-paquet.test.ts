import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyserModele, MODELE_BASE_CLIENT } from "@axion-auto/donnees-module";
import { describe, expect, it } from "vitest";
import { MODELE } from "./modele.js";

// Le paquet est pur (aucun accès disque) : son modèle est un instantané commité. Ce test, côté API, le compare à drizzle-cli.
// Instantané périmé : le régénérer avec serialiserModele(analyserModele(<drizzle-cli>)) du paquet, jamais à la main.
const dossier = fileURLToPath(new URL("../../../drizzle-cli/", import.meta.url));
const lu = () => analyserModele(readdirSync(dossier).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(`${dossier}${f}`, "utf8")).join("\n"));

describe("instantané du modèle", () => {
  it("[A-170] l'instantané du modèle du paquet égale drizzle-cli", () => {
    const attendu = lu();
    expect(attendu.tables.size).toBeGreaterThan(0);
    expect(MODELE_BASE_CLIENT).toEqual(attendu);
    expect(MODELE).toBe(MODELE_BASE_CLIENT);
  });
});
