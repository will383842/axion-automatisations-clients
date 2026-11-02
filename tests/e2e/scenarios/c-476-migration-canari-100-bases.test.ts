import { expect, test } from "vitest";
import { deroulerPlan, planifierVagues, type BaseRegistre, type PortsVagues } from "../../../apps/api/src/donnees/vagues.ts";

// Critère C-476 : une migration canari réussit sur 100 bases. Cette version rejoue le déroulement des vagues sur 100 bases fictives en mémoire (ordre, canari 5 %, lots, aucune quarantaine) ;
// la même exigence est prouvée sur de vraies bases PostgreSQL par apps/api/src/donnees/vagues.int.test.ts (job socle-integration, CREATE DATABASE … TEMPLATE en série).
test("[C-476] une migration canari réussit sur 100 bases fictives (déroulement des vagues)", async () => {
  const bases: BaseRegistre[] = Array.from({ length: 100 }, (_, i) => ({ id: `id${i}`, tenantId: `t${i}`, nomBase: `cli_${i.toString(16).padStart(12, "0")}`, versionStructure: 1, etat: "active" }));
  const alertes: unknown[] = [];
  const ports: PortsVagues = {
    async bases() { return bases.map((b) => ({ ...b })); },
    async graine() { return undefined; },
    async enregistrerGraine() {},
    tirerGraine: () => 476,
    async migrer() {},
    async noter(baseId, version, resultat) { if (resultat === "ok") bases.find((b) => b.id === baseId)!.versionStructure = version; },
    async alerter(a) { alertes.push(a); },
  };
  const plan = await planifierVagues(2, { recette: [bases[0]!.nomBase], internes: [bases[1]!.nomBase, bases[2]!.nomBase] }, ports);
  expect(plan.vagues.find((v) => v.nom === "canari")?.bases).toHaveLength(5);
  const r = await deroulerPlan(plan, ports);
  expect(r.arretee).toBe(false);
  expect(alertes).toEqual([]);
  expect(bases.every((b) => b.versionStructure === 2)).toBe(true);
});
