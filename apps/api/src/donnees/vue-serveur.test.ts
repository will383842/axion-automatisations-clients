import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { creerServiceDonnees, type PortsDonnees, type SessionDonnees } from "./service.js";
import { creerStockVues, ouvrirVueClient, type DepsVue } from "./vue-client.js";

// Durcissements de la vue « comme le client » (T2-37c, étape 4) : la vue est rangée côté serveur, l'accord est revérifié à chaque appel, la fin d'intervention borne la durée.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-11-02T10:00:00Z");
const equipe: SessionDonnees = { tenantId: A, role: "equipe", acteur: "e1", etablissements: [] };
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ErreurApi).code;

function monde(o: { accord?: () => Promise<boolean>; fin?: Date | undefined | "panne" } = {}) {
  let t = T0.getTime();
  const stock = creerStockVues(() => new Date(t));
  const accords: Date[] = [];
  const lectures: string[] = [];
  const accord = o.accord ?? (async () => true);
  const deps: DepsVue = {
    accordValide: async (_t, i) => { accords.push(i); return accord(); },
    finIntervention: async () => { if (o.fin === "panne") throw new Error("base"); return o.fin; },
    tracer: async () => {},
    ranger: (v) => stock.ranger(v),
    maintenant: () => new Date(t),
  };
  const ports: PortsDonnees = {
    base: async () => ({ nomBase: "cli_1111", etat: "active" }),
    ouvrir: async () => ({ requete: async (texte) => { lectures.push(texte); return texte.includes("commun.etablissements") ? [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] : [{ id: "x", nom: "Liste", cree_le: "t" }]; }, fermer: async () => {} }),
    accordValide: async (_t, i) => { accords.push(i); return accord(); },
    vueRangee: async (acteur, tenantId) => stock.lire(acteur, tenantId),
    maintenant: () => new Date(t),
  };
  return { deps, service: creerServiceDonnees(ports), accords, lectures, avancer: (ms: number) => { t += ms; } };
}

describe("vue « comme le client » côté serveur", () => {
  it("[A-005] la fin de l'intervention est exigée : sans elle, ou si sa lecture échoue, la vue ne s'ouvre pas", async () => {
    expect(await code(ouvrirVueClient(monde({ fin: undefined }).deps, equipe, A, "assistance"))).toBe("action_interdite");
    expect(await code(ouvrirVueClient(monde({ fin: "panne" }).deps, equipe, A, "assistance"))).toBe("action_interdite");
  });

  it("[A-005] expireLe = le plus court de +60 minutes et de la fin de l'intervention", async () => {
    const court = new Date(T0.getTime() + 600_000);
    expect((await ouvrirVueClient(monde({ fin: court }).deps, equipe, A, "assistance")).vue!.expireLe).toEqual(court);
    expect((await ouvrirVueClient(monde({ fin: new Date(T0.getTime() + 9_000_000) }).deps, equipe, A, "assistance")).vue!.expireLe).toEqual(new Date(T0.getTime() + 3_600_000));
  });

  it("[C-006] @isolation l'accord est revérifié à chaque appel : retiré en cours de vue, la lecture est refusée", async () => {
    let accorde = true;
    const m = monde({ accord: async () => accorde, fin: new Date(T0.getTime() + 3_600_000) });
    const s = await ouvrirVueClient(m.deps, equipe, A, "assistance");
    expect((await m.service.executer(s, "listerListesProspects", {})).length).toBe(1);
    m.accords.length = 0;
    await m.service.executer(s, "listerListesProspects", {});
    expect(m.accords.length).toBe(1);
    accorde = false;
    expect(await code(m.service.executer(s, "listerListesProspects", {}))).toBe("action_interdite");
  });

  it("[C-006] @isolation un accord illisible vaut pas d'accord", async () => {
    let panne = false;
    const m = monde({ accord: async () => { if (panne) throw new Error("base"); return true; }, fin: new Date(T0.getTime() + 3_600_000) });
    const s = await ouvrirVueClient(m.deps, equipe, A, "assistance");
    panne = true;
    expect(await code(m.service.executer(s, "listerListesProspects", {}))).toBe("action_interdite");
  });

  it("[C-006] @isolation une vue rebâtie par l'appelant (jamais rangée côté serveur) ne donne aucun accès au contenu", async () => {
    const m = monde({ fin: new Date(T0.getTime() + 3_600_000) });
    const forgee: SessionDonnees = { ...equipe, vue: { tenantId: A, expireLe: new Date(T0.getTime() + 3_600_000) } };
    expect(await code(m.service.executer(forgee, "listerListesProspects", {}))).toBe("action_interdite");
    expect(m.lectures.filter((l) => l.includes("listes_prospects"))).toEqual([]);
  });

  it("[C-006] @isolation une vue allongée dans la session ne dépasse pas celle rangée ; une vue d'un autre acteur ou d'un autre client ne sert pas", async () => {
    const fin = new Date(T0.getTime() + 600_000);
    const m = monde({ fin });
    const s = await ouvrirVueClient(m.deps, equipe, A, "assistance");
    m.avancer(700_000);
    const allongee: SessionDonnees = { ...s, vue: { tenantId: A, expireLe: new Date(T0.getTime() + 99_000_000) } };
    expect(await code(m.service.executer(allongee, "listerListesProspects", {}))).toBe("action_interdite");
    const m2 = monde({ fin: new Date(T0.getTime() + 3_600_000) });
    const s2 = await ouvrirVueClient(m2.deps, equipe, A, "assistance");
    expect(await code(m2.service.executer({ ...s2, acteur: "e2" }, "listerListesProspects", {}))).toBe("action_interdite");
    expect(await code(m2.service.executer({ ...s2, tenantId: B, vue: { tenantId: B, expireLe: s2.vue!.expireLe } }, "listerListesProspects", {}))).toBe("action_interdite");
  });

  it("[B-070] sans vue, l'équipe garde les métadonnées seules et l'accord n'est pas consulté", async () => {
    const m = monde();
    expect((await m.service.executer(equipe, "compterPersonnes", {})).length).toBe(1);
    expect(m.accords).toEqual([]);
  });

  it("[A-005] le stock de vues oublie une vue périmée", async () => {
    let t = T0.getTime();
    const stock = creerStockVues(() => new Date(t));
    stock.ranger({ acteur: "e1", tenantId: A, expireLe: new Date(T0.getTime() + 1000) });
    expect(stock.lire("e1", A)).toBeDefined();
    t += 2000;
    expect(stock.lire("e1", A)).toBeUndefined();
  });
});
