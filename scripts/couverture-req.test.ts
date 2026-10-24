import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extraireTests, lireLigneExigences, validerReqIds, verifierCouverture } from "./couverture-req.js";

const fixture = (nom: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/couverture/${nom}`, import.meta.url)), "utf8");
const reqs = validerReqIds(JSON.parse(fixture("req-ids.json")), JSON.parse(readFileSync(fileURLToPath(new URL("../spec/req-ids.schema.json", import.meta.url)), "utf8")));
const tests = [...extraireTests(JSON.parse(fixture("rapport-vitest.json"))), ...extraireTests(JSON.parse(fixture("rapport-playwright.json")))];
const preuves = fixture("preuves.md");
const verifier = (corps: string, t = tests, p = preuves) => verifierCouverture({ reqs, corps, tests: t, preuves: p });

describe("couverture-req", () => {
  it("[C-555] refuse un id inconnu", () => {
    const r = verifier("Exigences : C-999");
    expect(r.erreurs.join("\n")).toContain("exigence inconnue");
  });
  it("[C-555] refuse une REQ « test » sans test portant son numéro", () => {
    expect(verifier("Exigences : C-555", []).erreurs).not.toEqual([]);
    expect(verifier("Exigences : C-555").erreurs).toEqual([]);
  });
  it("[C-555] accepte une REQ « document » listée dans preuves.md", () => {
    expect(verifier("Exigences : C-392").erreurs).toEqual([]);
    expect(verifier("Exigences : C-392", tests, "").erreurs).not.toEqual([]);
  });
  it("[C-555] refuse un req-ids.json avec un champ texte en plus", () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../spec/req-ids.schema.json", import.meta.url)), "utf8"));
    expect(() => validerReqIds([{ id: "C-555", lot: "0", version: "V1", preuve: "test", texte: "…" }], schema)).toThrow();
  });
  it("[C-543] ne compte pas un test « .fails » comme preuve d'une exigence V1 du lot courant", () => {
    expect(verifier("Exigences : C-600").erreurs.join("\n")).toContain("C-600");
  });
  it("[C-555] refuse une PR sans ligne Exigences, accepte « aucune (outillage) » et les ids [LOT0-…]", () => {
    expect(verifier("rien").erreurs.join("\n")).toContain("ligne Exigences absente");
    expect(verifier("Exigences : aucune (outillage)").erreurs).toEqual([]);
    expect(verifier("Exigences : LOT0-structure").erreurs).toEqual([]);
    expect(verifier("Exigences : LOT0-structure").couverture).toEqual([]);
  });
  it("[C-555] refuse un identifiant mal formé et ne compte pas un test échoué", () => {
    expect(verifier("Exigences : C-55; rm -rf").erreurs).not.toEqual([]);
    expect(verifier("Exigences : C-543").erreurs).not.toEqual([]);
  });
  it("[C-555] lit la ligne Exigences comme du texte", () => {
    expect(lireLigneExigences("## x\nExigences : C-555, C-543\nsuite")).toBe("C-555, C-543");
    expect(lireLigneExigences("")).toBeNull();
  });
  it("[C-555] signale sans échouer un test portant un id V2", () => {
    const r = verifier("Exigences : C-555");
    expect(r.erreurs).toEqual([]);
    expect(r.avertissements.join("\n")).toContain("C-700");
  });
});
