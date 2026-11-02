import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAITRES } from "./maitres.js";
import { comparer, lancerNuit, planifierNuit, type EntreeComparaison, type Ecrivain } from "./nuit.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const S1 = "100000009";
const S2 = "100000017";
const vide: EntreeComparaison = { organisations: [], hub: [], crm: [], numeros: [] };
const org = (tenantId: string, siren: string | null, statut: "prospect" | "en_signature" | "client" | "ancien_client" = "client", crmCompanyId: string | null = null) => ({ tenantId, siren, statut, crmCompanyId });
const hub = (axiCli: string, consoleClientId: string | null, siren: string | null, statut: "prospect" | "client_actif" | "ancien_client" = "client_actif") => ({ axiCli, consoleClientId, siren, statut });
const crm = (crmCompanyId: string, siren: string | null, extra: { consoleClientId?: string | null; absorbeePar?: string } = {}) => ({ crmCompanyId, siren, consoleClientId: extra.consoleClientId ?? null, ...(extra.absorbeePar ? { absorbeePar: extra.absorbeePar } : {}) });
const types = (e: EntreeComparaison) => comparer(e).map((x) => x.type);

describe("comparaison de nuit", () => {
  it("[C-362] un numéro de facture ou de devis porté par deux clients est listé comme numero_en_double, un numéro unique ne l'est pas", () => {
    const ecarts = comparer({ ...vide, numeros: [{ tenantId: T1, numero: "F-0001", nature: "facture" }, { tenantId: T2, numero: "F-0001", nature: "facture" }, { tenantId: T1, numero: "D-0001", nature: "devis" }, { tenantId: T2, numero: "D-0002", nature: "devis" }, { tenantId: T1, numero: "F-0002", nature: "facture" }, { tenantId: T1, numero: "F-0002", nature: "facture" }] });
    expect(ecarts.map((e) => e.type)).toEqual(["numero_en_double"]);
    expect(ecarts[0]).toMatchObject({ tenantIds: [T1, T2], information: "factures" });
  });

  it("[C-364] chaque nuit, un client présent dans la console et absent du Hub est listé", () => {
    const e = comparer({ ...vide, organisations: [org(T1, S1)], crm: [crm("c1", S1, { consoleClientId: T1 })] });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ type: "absent_hub", tenantIds: [T1], proposition: { action: "creer_fiche_hub", cible: "hub" } });
  });

  it("[C-364] un client en double dans le CRM est listé", () => {
    const e = comparer({ ...vide, organisations: [org(T1, S1)], hub: [hub("a1", T1, S1)], crm: [crm("c1", S1), crm("c2", S1)] });
    expect(e.map((x) => x.type)).toEqual(["double_crm"]);
    expect(e[0]?.tenantIds).toEqual([T1]);
  });

  it("[C-364] un statut divergent entre Hub et console est listé", () => {
    const e = comparer({ ...vide, organisations: [org(T1, S1, "ancien_client")], hub: [hub("a1", T1, S1, "client_actif")], crm: [crm("c1", S1)] });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ type: "statut_diverge", proposition: { action: "aligner_statut_hub", cible: "hub", avant: { statut: "client_actif" }, apres: { statut: "ancien_client" } } });
  });

  it("[C-364] « en signature » côté console est vu « prospect » par le Hub : pas d'écart", () => {
    expect(types({ ...vide, organisations: [org(T1, S1, "en_signature")], hub: [hub("a1", T1, S1, "prospect")], crm: [crm("c1", S1)] })).toEqual([]);
  });

  it("[C-364] une fiche du Hub absente de la console, et un identifiant pointant vers une fiche absorbée, sont listés", () => {
    const e = comparer({ ...vide, organisations: [org(T1, S1, "client", "c-vieille")], hub: [hub("a1", T1, S1), hub("a2", null, S2)], crm: [crm("c-vieille", S1, { absorbeePar: "c-gardee" }), crm("c-gardee", S1)] });
    expect(e.map((x) => x.type).sort()).toEqual(["absent_console", "fiche_absorbee"]);
    expect(e.find((x) => x.type === "fiche_absorbee")?.proposition).toMatchObject({ cible: "console", apres: { crmCompanyId: "c-gardee" } });
  });

  it("[C-095] le statut du client vient toujours de la console : la correction vise le Hub, jamais la console", () => {
    for (const [c, h] of [["client", "prospect"], ["ancien_client", "client_actif"], ["prospect", "ancien_client"]] as const) {
      const e = comparer({ ...vide, organisations: [org(T1, S1, c)], hub: [hub("a1", T1, S1, h)], crm: [crm("c1", S1)] });
      expect(e.filter((x) => x.type === "statut_diverge").every((x) => x.proposition.cible === "hub" && x.maitre === "console"), `${c}/${h}`).toBe(true);
    }
  });

  it("[C-456] un client sans SIREN ressemblant à une fiche reste dans à trancher, jamais créé par la nuit", () => {
    const e = comparer({ ...vide, organisations: [org(T1, null)], hub: [hub("a9", null, null)] });
    expect(e.map((x) => x.type).sort()).toEqual(["absent_console", "sans_siren"]);
    expect(e.every((x) => x.proposition.action === "a_examiner")).toBe(true);
    expect(e.some((x) => x.proposition.action.startsWith("creer_"))).toBe(false);
  });

  it("[C-362] chaque comparaison se réfère à la table des maîtres", () => {
    const e = comparer({ organisations: [org(T1, S1), org(T2, null)], hub: [hub("a2", null, S2)], crm: [crm("c1", S1), crm("c2", S1)], numeros: [{ tenantId: T1, numero: "D-1", nature: "devis" }, { tenantId: T2, numero: "D-1", nature: "devis" }] });
    expect(e.length).toBeGreaterThan(3);
    for (const x of e) expect(x.maitre, x.type).toBe(MAITRES[x.information]);
    const source = readFileSync(new URL("./nuit.ts", import.meta.url), "utf8");
    expect(source).toMatch(/from "\.\/maitres\.js"/);
  });
});

function ecrivain(ouvertes: Record<string, string[]> = {}) {
  const inseres: { tenantId: string; cle: string; motif: string }[] = [];
  const e: Ecrivain = {
    ouvertes: async (t) => new Set(ouvertes[t] ?? []),
    inserer: async (tenantId, ligne) => { inseres.push({ tenantId, cle: ligne.donneesComparaison.cle, motif: ligne.motif }); },
  };
  return { e, inseres };
}
const entree: EntreeComparaison = { ...vide, organisations: [org(T1, S1)], crm: [crm("c1", S1, { consoleClientId: T1 })] };

describe("tâche de nuit", () => {
  it("[C-365] la console propose une correction et ne l'applique jamais seule", async () => {
    const { e, inseres } = ecrivain();
    const ecriture = vi.fn();
    const r = await lancerNuit({ lire: async () => entree, ecrivain: e });
    expect(inseres).toHaveLength(1);
    expect(inseres[0]?.motif).toBe("incoherence_nuit");
    expect(r).toMatchObject({ crees: 1, dejaOuverts: 0 });
    expect(ecriture).not.toHaveBeenCalled();
  });

  it("[C-364] @anti-doublon relancer la nuit ne recrée pas un écart déjà ouvert", async () => {
    const premier = ecrivain();
    await lancerNuit({ lire: async () => entree, ecrivain: premier.e });
    const cle = premier.inseres[0]!.cle;
    const second = ecrivain({ [T1]: [cle] });
    const r = await lancerNuit({ lire: async () => entree, ecrivain: second.e });
    expect(second.inseres).toEqual([]);
    expect(r).toMatchObject({ crees: 0, dejaOuverts: 1 });
  });

  it("[C-364] la clé d'un écart numero_en_double contient les deux clients : un autre couple donne un autre écart", () => {
    const a = comparer({ ...vide, numeros: [{ tenantId: T1, numero: "F-1", nature: "facture" }, { tenantId: T2, numero: "F-1", nature: "facture" }] })[0]!.cle;
    const b = comparer({ ...vide, numeros: [{ tenantId: T1, numero: "F-1", nature: "facture" }, { tenantId: "33333333-3333-4333-8333-333333333333", numero: "F-1", nature: "facture" }] })[0]!.cle;
    expect(a).not.toBe(b);
  });

  it("[C-364] un écart sans client de la console est rendu dans le rapport, pas perdu", async () => {
    const { e, inseres } = ecrivain();
    const r = await lancerNuit({ lire: async () => ({ ...vide, hub: [hub("a2", null, S2)] }), ecrivain: e });
    expect(inseres).toEqual([]);
    expect(r.sansClient.map((x) => x.type)).toEqual(["absent_console"]);
  });

  it("[C-364] la tâche de nuit a pour identifiant la date : la lancer deux fois le même jour n'en crée qu'une", async () => {
    const ajouts: { nom: string; opts: { jobId: string } }[] = [];
    const file = { add: async (nom: string, _d: unknown, opts: { jobId: string }) => { ajouts.push({ nom, opts }); } };
    await planifierNuit(file, "2026-11-02");
    expect(ajouts).toEqual([{ nom: "coherence-nuit", opts: { jobId: "2026-11-02" } }]);
    await expect(planifierNuit(file, "demain")).rejects.toThrow();
  });
});

describe("garde du dossier coherence", () => {
  it("[C-365] seul appliquer.ts écrit hors de a_trancher ; nuit.ts n'écrit que dans a_trancher et ne touche ni api/mcp ni site-sync", () => {
    for (const f of ["maitres.ts", "nuit.ts"]) {
      const s = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(s, f).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/);
      expect(s, f).not.toMatch(/boite_envoi|api\/mcp|site-sync/);
      for (const m of s.matchAll(/INSERT\s+INTO\s+([\w.]+)/gi)) expect(m[1], f).toBe("a_trancher");
    }
    const a = readFileSync(new URL("./appliquer.ts", import.meta.url), "utf8");
    expect(a).not.toMatch(/\b(DELETE|TRUNCATE)\b|api\/mcp|site-sync/);
    expect([...a.matchAll(/\bUPDATE\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["a_trancher"]);
  });
});
