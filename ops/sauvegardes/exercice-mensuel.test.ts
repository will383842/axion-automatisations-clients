import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lancerExercice, type PortsExercice } from "./exercice-mensuel.js";

const nom = (i: number) => `cli_${i.toString(16).padStart(12, "0")}`;
function monde(n = 10) {
  const bases = Array.from({ length: n }, (_, i) => ({ tenantId: randomUUID(), nomBase: nom(i) }));
  const j = { temporaires: new Map<string, string>(), retirees: [] as string[], notes: [] as { tenantId: string; le: Date; ok: boolean }[], bascules: 0, graines: [] as number[] };
  const p: PortsExercice = {
    async bases() { return bases; },
    tirerGraine: () => 241,
    async noterGraine(g) { j.graines.push(g); },
    async preparer(tenantId) { const t = `${bases.find((b) => b.tenantId === tenantId)!.nomBase}_restau_1`; j.temporaires.set(t, tenantId); return t; },
    async sommeDeControle(nomBase) { return `somme:${nomBase.replace(/_restau_\d+$/, "")}`; },
    async noter(tenantId, le, ok) { j.notes.push({ tenantId, le, ok }); },
    async retirer(nomBase) { j.retirees.push(nomBase); j.temporaires.delete(nomBase); },
  };
  return { bases, j, p };
}

describe("exercice-mensuel", () => {
  it("[A-241] l'exercice tire 3 bases, vérifie leur restauration et note la date", async () => {
    const { p, j } = monde(); const le = new Date("2026-11-05T02:00:00Z");
    const r = await lancerExercice(p, le);
    expect(r.resultats).toHaveLength(3);
    expect(new Set(r.resultats.map((x) => x.tenantId)).size).toBe(3);
    expect(r.resultats.every((x) => x.ok)).toBe(true);
    expect(j.notes.map((x) => x.le)).toEqual([le, le, le]);
    expect(j.graines).toEqual([241]);
    expect(r.graine).toBe(241);
    expect((await lancerExercice(monde().p, le)).resultats.map((x) => x.nomBase)).toEqual(r.resultats.map((x) => x.nomBase));
  });
  it("[A-241] une somme de contrôle différente est notée en échec", async () => {
    const { p, j } = monde(); p.sommeDeControle = async (n) => (n.includes("_restau_") ? "autre" : "somme");
    const r = await lancerExercice(p, new Date());
    expect(r.resultats.every((x) => !x.ok)).toBe(true);
    expect(j.notes.every((x) => !x.ok)).toBe(true);
  });
  it("[A-241] l'exercice ne retire que les bases temporaires qu'il a créées", async () => {
    const { p, j, bases } = monde();
    const preparer = p.preparer; p.preparer = async (t) => { const n = await preparer(t); return n; };
    const r = await lancerExercice(p, new Date());
    expect(j.retirees.sort()).toEqual(r.resultats.map((x) => x.nomBase).sort());
    expect(j.retirees.every((n) => n.includes("_restau_"))).toBe(true);
    expect(j.retirees.some((n) => bases.some((b) => b.nomBase === n))).toBe(false);
  });
  it("[A-241] un nom qui n'est pas temporaire n'est jamais retiré", async () => {
    const { p, j, bases } = monde();
    p.preparer = async (t) => bases.find((b) => b.tenantId === t)!.nomBase;
    await expect(lancerExercice(p, new Date())).rejects.toThrow("base_non_temporaire");
    expect(j.retirees).toHaveLength(0);
  });
  it("[A-241] moins de 3 bases : toutes sont tirées, et les bases retirées même si une comparaison échoue", async () => {
    const { p, j } = monde(2);
    const r = await lancerExercice(p, new Date());
    expect(r.resultats).toHaveLength(2);
    const m = monde(4); m.p.sommeDeControle = async () => { throw new Error("lecture_echouee"); };
    await expect(lancerExercice(m.p, new Date())).rejects.toThrow("lecture_echouee");
    expect(m.j.temporaires.size).toBe(0);
    expect(j.temporaires.size).toBe(0);
  });
});
