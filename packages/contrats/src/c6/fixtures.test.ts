import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifierJeton } from "./verifier.ts";

type Fixture = { cles: { kid: string; secret: string }[]; maintenant: number; cas: { nom: string; valide: boolean; jeton: string }[] };
const f = JSON.parse(readFileSync(new URL("../../fixtures/c6/jetons.json", import.meta.url), "utf8")) as Fixture;

describe("C6 fixtures (le back-office d'axion-ia les rejoue)", () => {
  it("[LOT0-c6] chaque jeton de fixture est accepté ou refusé comme annoncé", () => {
    expect(f.cas.length).toBeGreaterThanOrEqual(4);
    for (const c of f.cas) expect(verifierJeton(f.cles, c.jeton, f.maintenant, () => false).ok, c.nom).toBe(c.valide);
  });
});
