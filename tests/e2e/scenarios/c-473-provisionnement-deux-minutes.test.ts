import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { formaterMesure, mesurerCreations, SEUIL_CREATION_MS } from "../../../apps/api/src/provisionnement/etapes-fin.ts";

// Critère C-473 : une base client est provisionnée en moins de 2 minutes. Il n'est VRAI que si une mesure réelle de cinq créations de bout en bout est écrite
// dans ops/donnees/mesure-provisionnement.md (ligne produite par formaterMesure, seuil respecté). Tant qu'elle manque : test.fails. À passer en test quand la mesure existe (dette LOT2-dette-T2-35).
test.fails("[C-473] une base client est provisionnée en moins de 2 minutes @lot-2b", () => {
  const texte = readFileSync(new URL("../../../ops/donnees/mesure-provisionnement.md", import.meta.url), "utf8");
  expect(texte).toMatch(/^Mesure du \d{4}-\d{2}-\d{2} sur .+ : 5 créations, médiane \d+ s, maximum \d+ s, seuil 120 s : respecté\.$/m);
});

// Aide de mesure seulement : ces essais ne prouvent PAS C-473 (aucune durée réelle), ils portent donc une étiquette d'aide et non l'exigence.
test("[C-473] partie vérifiable : le seuil est figé à 120 s, médiane et maximum sont calculés (la mesure réelle reste due)", async () => {
  expect(SEUIL_CREATION_MS).toBe(120_000);
  let t = 0;
  const durees = [40_000, 62_000, 51_000, 119_999, 70_000];
  let i = 0;
  const r = await mesurerCreations(5, async () => { t += durees[i++]!; }, () => t);
  expect(r.durees).toEqual(durees);
  expect(r.maximum).toBe(119_999);
  expect(r.mediane).toBe(62_000);
  expect(r.toutesSousLeSeuil).toBe(true);
  expect(formaterMesure(r, { date: "2026-11-02", machine: "essai" })).toContain("62");
});

test("[aide-mesure] une création qui dépasse 2 minutes fait échouer la mesure, sans relever le seuil", async () => {
  let t = 0;
  const r = await mesurerCreations(2, async () => { t += 120_000; }, () => t);
  expect(r.toutesSousLeSeuil).toBe(false);
});
