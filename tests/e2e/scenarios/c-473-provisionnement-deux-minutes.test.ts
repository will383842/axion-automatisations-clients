import { expect, test } from "vitest";
import { formaterMesure, mesurerCreations, SEUIL_CREATION_MS } from "../../../apps/api/src/provisionnement/etapes-fin.ts";

// Critère C-473 : une base client est provisionnée en moins de 2 minutes. Le seuil n'est jamais relevé ; la mesure réelle (5 créations de bout en bout)
// est l'essai [A-223] de apps/api/src/provisionnement/mesure.int.test.ts, qui écrit ops/donnees/mesure-provisionnement.md.
test("[C-473] une base client est provisionnée en moins de 2 minutes", async () => {
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

test("[C-473] une création qui dépasse 2 minutes fait échouer la mesure, sans relever le seuil", async () => {
  let t = 0;
  const r = await mesurerCreations(2, async () => { t += 120_000; }, () => t);
  expect(r.toutesSousLeSeuil).toBe(false);
});
