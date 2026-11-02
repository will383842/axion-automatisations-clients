import { describe, expect, it } from "vitest";
import { deroulerPlan, deroulerVague, planifierVagues, type BaseRegistre, type PortsVagues } from "./vagues.ts";

const nom = (i: number) => `cli_${i.toString(16).padStart(12, "0")}`;
const base = (i: number, version = 1, etat = "active"): BaseRegistre => ({ id: `id${i}`, tenantId: `t${i}`, nomBase: nom(i), versionStructure: version, etat });
const parc = (n: number) => Array.from({ length: n }, (_, i) => base(i + 1));
const CONFIG = { recette: [nom(1)], internes: [nom(2), nom(3)] };

function monde(bases: BaseRegistre[], echouent: string[] = []) {
  const journal = { migrees: [] as string[], notes: [] as string[], alertes: [] as { type: string; clientId: string }[], graines: new Map<number, number>(), enCours: 0, pic: 0 };
  const ports: PortsVagues = {
    async bases() { return bases.map((b) => ({ ...b })); },
    async graine(v) { return journal.graines.get(v); },
    async enregistrerGraine(v, g) { journal.graines.set(v, g); },
    tirerGraine: () => 12345,
    async migrer(nomBase, cible) {
      journal.enCours++;
      journal.pic = Math.max(journal.pic, journal.enCours);
      await new Promise((r) => setTimeout(r, 1));
      journal.enCours--;
      if (echouent.includes(nomBase)) throw new Error("échec simulé");
      journal.migrees.push(nomBase);
      const b = bases.find((x) => x.nomBase === nomBase)!;
      b.versionStructure = cible;
    },
    async noter(baseId, version, resultat) { journal.notes.push(`${baseId}:${version}:${resultat}`); },
    async alerter(a) { journal.alertes.push(a); },
  };
  return { ports, journal, bases };
}

describe("migrations par vagues", () => {
  it("[A-227] les vagues suivent l'ordre recette, internes, canari 5 %, lots de 50", async () => {
    const { ports } = monde(parc(100));
    const plan = await planifierVagues(2, CONFIG, ports);
    expect(plan.vagues.map((v) => v.nom)).toEqual(["recette", "internes", "canari", "lot", "lot"]);
    expect(plan.vagues.map((v) => v.bases.length)).toEqual([1, 2, 5, 50, 42]);
    expect(plan.vagues[0]!.bases[0]!.nomBase).toBe(nom(1));
    // 5 % des 97 bases restantes, arrondi au supérieur ; aucune base deux fois.
    const toutes = plan.vagues.flatMap((v) => v.bases.map((b) => b.nomBase));
    expect(new Set(toutes).size).toBe(100);
    expect(plan.vagues.map((v) => v.numero)).toEqual([1, 2, 3, 4, 5]);
  });

  it("[A-227] seules les bases actives encore en retard sont planifiées", async () => {
    const { ports } = monde([base(1), base(2, 2), base(3, 1, "gelee"), base(4), base(5, 1, "en_creation")]);
    const plan = await planifierVagues(2, { recette: [nom(1)], internes: [] }, ports);
    expect(plan.vagues.flatMap((v) => v.bases.map((b) => b.nomBase))).toEqual([nom(1), nom(4)]);
  });

  it("[A-227] la graine du canari est écrite au journal et une vague se rejoue à l'identique, même avec une autre graine demandée", async () => {
    const { ports, journal } = monde(parc(100));
    const un = await planifierVagues(2, CONFIG, ports);
    expect(journal.graines.get(2)).toBe(12345);
    const deux = await planifierVagues(2, CONFIG, ports);
    expect(deux.vagues.map((v) => v.bases.map((b) => b.nomBase))).toEqual(un.vagues.map((v) => v.bases.map((b) => b.nomBase)));
    await expect(planifierVagues(2, CONFIG, ports, { graine: 999 })).rejects.toThrow(/graine/);
    // Une autre graine, pour une autre version, change bien le tirage.
    const autre = await planifierVagues(3, CONFIG, { ...ports, tirerGraine: () => 777 });
    expect(autre.vagues[2]!.bases.map((b) => b.nomBase)).not.toEqual(un.vagues[2]!.bases.map((b) => b.nomBase));
  });

  it("[A-228] une base en échec reste sur l'ancienne version, part en quarantaine et alerte ; les autres continuent", async () => {
    const m2 = monde(parc(10), [nom(5)]);
    const p2 = await planifierVagues(2, { recette: [nom(4)], internes: [] }, m2.ports);
    const res = await deroulerPlan(p2, m2.ports, { seuilEchec: 1 });
    expect(m2.bases.find((b) => b.nomBase === nom(5))!.versionStructure).toBe(1);
    expect(m2.journal.notes).toContain("id5:2:quarantaine");
    expect(m2.journal.alertes).toEqual([{ type: "migration_echec", clientId: "t5" }]);
    expect(m2.journal.migrees).toHaveLength(9);
    expect(res.vagues.flatMap((v) => v.echecs)).toEqual([nom(5)]);
  });

  it("[A-228] au-delà de 2 % d'échecs dans une vague, les vagues suivantes s'arrêtent ; reprise après correction", async () => {
    const m = monde(parc(100), [nom(1)]);
    const plan = await planifierVagues(2, CONFIG, m.ports);
    const res = await deroulerPlan(plan, m.ports);
    // La recette (1 base sur 1) échoue : 100 % > 2 %, rien d'autre n'est migré.
    expect(res.arretee).toBe(true);
    expect(res.vagues).toHaveLength(1);
    expect(m.journal.migrees).toEqual([]);
    // Seuil configurable : à 100 %, on passe outre.
    const m2 = monde(parc(100), [nom(1)]);
    const res2 = await deroulerPlan(await planifierVagues(2, CONFIG, m2.ports), m2.ports, { seuilEchec: 1 });
    expect(res2.arretee).toBe(false);
    // Reprise après correction : le même plan (même graine) ne reprend que ce qui reste en retard.
    m.journal.migrees.length = 0;
    const reprise = await planifierVagues(2, CONFIG, { ...m.ports, migrer: async (n, c) => { m.journal.migrees.push(n); m.bases.find((b) => b.nomBase === n)!.versionStructure = c; } });
    expect(reprise.vagues[0]!.bases.map((b) => b.nomBase)).toEqual([nom(1)]);
    expect(reprise.graine).toBe(12345);
  });

  it("[A-228] la migration est bornée à 5 bases en parallèle", async () => {
    const m = monde(parc(40));
    const plan = await planifierVagues(2, { recette: [], internes: [] }, m.ports);
    await deroulerVague(plan.vagues.find((v) => v.nom === "lot")!, m.ports);
    expect(m.journal.pic).toBeLessThanOrEqual(5);
    expect(m.journal.pic).toBeGreaterThan(1);
  });

  it("[A-227] une vague ne migre que des bases du registre : nom ou client falsifié refusé avant toute migration", async () => {
    const m = monde(parc(5));
    const plan = await planifierVagues(2, { recette: [nom(1)], internes: [] }, m.ports);
    const vague = plan.vagues[0]!;
    await expect(deroulerVague({ ...vague, bases: [{ ...vague.bases[0]!, nomBase: nom(4) }] }, m.ports)).rejects.toThrow(/registre/);
    await expect(deroulerVague({ ...vague, bases: [{ ...vague.bases[0]!, nomBase: "cli_ffffffffffff", id: "inconnu" }] }, m.ports)).rejects.toThrow(/registre/);
    expect(m.journal.migrees).toEqual([]);
  });
});
