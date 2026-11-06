import { describe, expect, it } from "vitest";
import { SondageMutualise } from "./mutualise.ts";

const CONN_A = "client-a:compte-1";
const CONN_B = "client-b:compte-1"; // même adresse de boîte, autre client : jamais fusionné


describe("sondage mutualisé", () => {
  it("[A-416] 20 instances d'un client sur une même boîte : une seule lecture par intervalle", async () => {
    let t = 1_000;
    let appels = 0;
    const sondage = new SondageMutualise({ maintenant: () => t, intervalleMs: 60_000 });
    const releve = async () => ({ elements: [`m${++appels}`], curseur: String(appels) });
    const instances = Array.from({ length: 20 }, (_, i) => `inst-${i}`);
    const vus = await Promise.all(instances.map((i) => sondage.lire(CONN_A, i, releve)));
    expect(appels).toBe(1);
    expect(vus.every((v) => v.elements.join() === "m1")).toBe(true);
    // dans l'intervalle : aucune nouvelle lecture
    t += 30_000;
    await Promise.all(instances.map((i) => sondage.lire(CONN_A, i, releve)));
    expect(appels).toBe(1);
    // intervalle suivant : une seule lecture de plus, chaque instance voit le nouvel élément une fois
    t += 31_000;
    const apres = await Promise.all(instances.map((i) => sondage.lire(CONN_A, i, releve)));
    expect(appels).toBe(2);
    expect(apres.every((v) => v.elements.join() === "m2")).toBe(true);
  });

  it("[A-416] la clé est la connexion (client et compte), pas l'adresse : deux clients ne sont jamais fusionnés", async () => {
    const sondage = new SondageMutualise({ maintenant: () => 1_000, intervalleMs: 60_000 });
    let appels = 0;
    const releve = async () => ({ elements: [`m${++appels}`], curseur: String(appels) });
    const a = await sondage.lire(CONN_A, "inst-a", releve);
    const b = await sondage.lire(CONN_B, "inst-b", releve);
    expect(appels).toBe(2);
    expect(a.elements).not.toEqual(b.elements);
  });

  it("[A-416] le curseur appartient à la connexion et ne recule pas ; une lecture en échec ne l'avance pas", async () => {
    let t = 1_000;
    const sondage = new SondageMutualise({ maintenant: () => t, intervalleMs: 10 });
    const vus: (string | undefined)[] = [];
    const ok = async (c: string | undefined) => (vus.push(c), { elements: ["x"], curseur: "c1" });
    await sondage.lire(CONN_A, "i1", ok);
    t += 20;
    await expect(sondage.lire(CONN_A, "i1", async () => Promise.reject(new Error("panne")))).rejects.toThrow("panne");
    t += 20;
    await sondage.lire(CONN_A, "i2", ok);
    expect(vus).toEqual([undefined, "c1"]);
  });

  it("[A-416] avec les notifications du fournisseur, la lecture suit la notification et non l'intervalle", async () => {
    let t = 1_000;
    let appels = 0;
    const sondage = new SondageMutualise({ maintenant: () => t, intervalleMs: 60_000, notifications: true });
    const releve = async () => ({ elements: [`m${++appels}`], curseur: String(appels) });
    await sondage.lire(CONN_A, "i1", releve);
    t += 120_000; // deux intervalles sans notification : pas de lecture
    expect((await sondage.lire(CONN_A, "i1", releve)).elements).toEqual([]);
    expect(appels).toBe(1);
    sondage.notifier(CONN_A);
    expect((await sondage.lire(CONN_A, "i1", releve)).elements).toEqual(["m2"]);
    expect(appels).toBe(2);
  });
});
