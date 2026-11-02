import { expect, test } from "vitest";
import { deroulerPlan, planifierVagues, type BaseRegistre, type PortsVagues } from "../../../apps/api/src/donnees/vagues.ts";

// Critère C-476 : une migration canari réussit sur 100 bases. Cette version rejoue le déroulement des vagues sur 100 bases fictives SIMULÉES (pas de PostgreSQL ici) :
// chaque base garde ses colonnes, la migration additive ajoute une colonne et échoue si elle existe déjà (comme dans PostgreSQL), le registre ne bouge que sur « ok ».
// La même exigence sur de vraies bases PostgreSQL est écrite dans apps/api/src/donnees/vagues.int.test.ts (job socle-integration) ; ce fichier ne le remplace pas.
const nom = (i: number) => `cli_${i.toString(16).padStart(12, "0")}`;
function monde(n: number, dejaMigrees: number[] = []) {
  const bases: BaseRegistre[] = Array.from({ length: n }, (_, i) => ({ id: `id${i}`, tenantId: `t${i}`, nomBase: nom(i), versionStructure: 1, etat: "active" }));
  const colonnes = new Map(bases.map((b, i) => [b.nomBase, new Set<string>(dejaMigrees.includes(i) ? ["note_canari"] : [])]));
  const alertes: { type: string; clientId: string }[] = [];
  const notes: string[] = [];
  const ports: PortsVagues = {
    async bases() { return bases.map((b) => ({ ...b })); },
    async graine() { return undefined; },
    async enregistrerGraine() {},
    tirerGraine: () => 476,
    async migrer(nomBase) {
      const cols = colonnes.get(nomBase)!;
      if (cols.has("note_canari")) throw new Error("colonne déjà présente");
      cols.add("note_canari");
    },
    async noter(baseId, version, resultat) { notes.push(resultat); if (resultat === "ok") bases.find((b) => b.id === baseId)!.versionStructure = version; },
    async alerter(a) { alertes.push(a); },
  };
  return { bases, colonnes, alertes, notes, ports };
}
const CONFIG = { recette: [nom(0)], internes: [nom(1), nom(2)] };

test("[C-476] une migration canari réussit sur 100 bases fictives (déroulement des vagues)", async () => {
  const m = monde(100);
  const plan = await planifierVagues(2, CONFIG, m.ports);
  expect(plan.vagues.find((v) => v.nom === "canari")?.bases).toHaveLength(5);
  const r = await deroulerPlan(plan, m.ports);
  expect(r.arretee).toBe(false);
  expect(m.alertes).toEqual([]);
  expect(m.bases.every((b) => b.versionStructure === 2)).toBe(true);
  // La migration a réellement touché chaque base simulée.
  expect([...m.colonnes.values()].every((c) => c.has("note_canari"))).toBe(true);
});

test("[A-228] une base dont la migration échoue reste en version 1 et alerte ; les 99 autres migrent", async () => {
  const m = monde(100, [60]);
  const plan = await planifierVagues(2, CONFIG, m.ports);
  const r = await deroulerPlan(plan, m.ports);
  expect(r.vagues.flatMap((v) => v.echecs)).toEqual([nom(60)]);
  expect(m.alertes).toEqual([{ type: "migration_echec", clientId: "t60" }]);
  expect(m.bases.filter((b) => b.versionStructure === 1).map((b) => b.nomBase)).toEqual([nom(60)]);
  expect(m.bases.filter((b) => b.versionStructure === 2)).toHaveLength(99);
  expect(m.notes.filter((x) => x === "quarantaine")).toHaveLength(1);
});
