import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { MAITRES } from "./maitres.js";
import { comparer, ecrivainSql, lancerNuit, planifierNuit, type EntreeComparaison, type Ecrivain } from "./nuit.js";

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
    expect(ecarts.map((e) => e.type)).toEqual(["numero_en_double", "numero_en_double"]);
    expect(ecarts.map((e) => e.tenantIds)).toEqual([[T1], [T2]]);
    expect(ecarts[0]).toMatchObject({ information: "factures", proposition: { action: "a_examiner" } });
  });

  it("[C-362] numero_en_double : une ligne par client sous son propre tenantId, avec une clé propre qui ne cite jamais l'autre client", async () => {
    const entreeDouble: EntreeComparaison = { ...vide, organisations: [org(T1, S1), org(T2, S2)], hub: [hub("a1", T1, S1), hub("a2", T2, S2)], crm: [crm("c1", S1, { consoleClientId: T1 }), crm("c2", S2, { consoleClientId: T2 })], numeros: [{ tenantId: T1, numero: "F-0001", nature: "facture" }, { tenantId: T2, numero: "F-0001", nature: "facture" }] };
    const { e, inseres } = ecrivain();
    await lancerNuit({ lire: async () => entreeDouble, ecrivain: e });
    expect(inseres.map((i) => i.tenantId).sort()).toEqual([T1, T2]);
    for (const i of inseres) {
      expect(i.cle).toBe("numero_en_double:facture:F-0001");
      expect(i.cle).not.toContain(T1);
      expect(i.cle).not.toContain(T2);
    }
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

  it("[C-362] le Hub fait foi : aucune proposition qui écrit ne vise le maître de son information (console ou Hub), et devis et factures ne sont jamais corrigés dans la console", () => {
    const e = comparer({
      organisations: [org(T1, S1), org(T2, null), org("33333333-3333-4333-8333-333333333333", "100000025", "ancien_client", "c-vieille"), org("44444444-4444-4444-8444-444444444444", "100000033", "client")],
      hub: [hub("a2", null, S2), hub("a3", "33333333-3333-4333-8333-333333333333", "100000025", "client_actif"), hub("a4", null, "100000041"), hub("a5", null, "100000041")],
      crm: [crm("c1", S1), crm("c2", S1), crm("c-vieille", "100000025", { absorbeePar: "c-gardee" }), crm("c-gardee", "100000025")],
      numeros: [{ tenantId: T1, numero: "D-1", nature: "devis" }, { tenantId: T2, numero: "D-1", nature: "devis" }, { tenantId: T1, numero: "F-1", nature: "facture" }, { tenantId: T2, numero: "F-1", nature: "facture" }],
    });
    expect(new Set(e.map((x) => x.type))).toEqual(new Set(["absent_hub", "absent_crm", "absent_console", "double_crm", "double_hub", "statut_diverge", "fiche_absorbee", "numero_en_double", "sans_siren"]));
    for (const x of e) {
      expect(x.maitre, x.type).toBe(MAITRES[x.information]);
      const ecrit = x.proposition.action !== "a_examiner";
      if (ecrit && x.maitre !== "crm") expect(x.proposition.cible, `${x.type} : le maître ne se corrige pas`).not.toBe(x.maitre);
      if (x.information === "devis" || x.information === "factures") {
        expect(x.proposition.action, `${x.type} : devis et factures ne sont jamais corrigés ici`).toBe("a_examiner");
        expect(x.proposition.apres, x.type).toEqual({});
      }
    }
    expect(readFileSync(new URL("./nuit.ts", import.meta.url), "utf8")).toMatch(/from "\.\/maitres\.js"/);
  });
});

function ecrivain(ouvertes: Record<string, string[]> = {}) {
  const inseres: { tenantId: string; cle: string; motif: string }[] = [];
  const e: Ecrivain = {
    ouvertes: async (t) => new Set(ouvertes[t] ?? []),
    inserer: async (tenantId, ligne) => { inseres.push({ tenantId, cle: ligne.donneesComparaison.cle, motif: ligne.motif }); },
    fermerPerimees: async () => 0,
  };
  return { e, inseres };
}
// Faux « à trancher » en mémoire : garde l'état d'une nuit à l'autre, comme la table.
function memoire() {
  const lignes: { tenantId: string; cle: string; etat: "ouvert" | "tranche"; decision: string | null }[] = [];
  const e: Ecrivain = {
    ouvertes: async (t) => new Set(lignes.filter((l) => l.tenantId === t && l.etat === "ouvert").map((l) => l.cle)),
    inserer: async (tenantId, l) => { lignes.push({ tenantId, cle: l.donneesComparaison.cle, etat: "ouvert", decision: null }); },
    fermerPerimees: async (t, produites) => {
      const a = lignes.filter((l) => l.tenantId === t && l.etat === "ouvert" && !produites.has(l.cle));
      for (const l of a) { l.etat = "tranche"; l.decision = "resolu:nuit"; }
      return a.length;
    },
  };
  return { e, lignes };
}
const entree: EntreeComparaison = { ...vide, organisations: [org(T1, S1)], crm: [crm("c1", S1, { consoleClientId: T1 })] };

describe("tâche de nuit", () => {
  it("[C-365] la console propose une correction et ne l'applique jamais seule : aucun appel ne sort de inserer, sauf l'insertion dans à trancher", async () => {
    const requetes: string[] = [];
    const client = { query: async (sql: string) => { requetes.push(sql); return { rows: [], rowCount: 0 }; }, release: () => undefined };
    const pool = { connect: async () => client } as unknown as Pool;
    const r = await lancerNuit({ lire: async () => entree, ecrivain: ecrivainSql(pool) });
    expect(r).toMatchObject({ crees: 1, dejaOuverts: 0 });
    const ecritures = requetes.filter((q) => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(q));
    expect(ecritures).toHaveLength(2);
    expect(ecritures.filter((q) => /^INSERT INTO a_trancher /.test(q))).toHaveLength(1);
    // La seule modification est la fermeture des lignes périmées, bornée au motif de la nuit.
    expect(ecritures.filter((q) => /^UPDATE a_trancher SET etat = 'tranche'.*motif = 'incoherence_nuit'/.test(q))).toHaveLength(1);
    expect(requetes.some((q) => /boite_envoi|organisations SET|devis|factures/i.test(q) && /\b(INSERT|UPDATE|DELETE)\b/i.test(q))).toBe(false);
  });

  it("[C-364] @anti-doublon relancer la nuit ne recrée pas un écart déjà ouvert", async () => {
    const m = memoire();
    await lancerNuit({ lire: async () => entree, ecrivain: m.e });
    const r = await lancerNuit({ lire: async () => entree, ecrivain: m.e });
    expect(m.lignes).toHaveLength(1);
    expect(r).toMatchObject({ crees: 0, dejaOuverts: 1, fermees: 0 });
  });

  it("[C-364] la clé d'un statut divergent contient la valeur proposée : une valeur proposée différente donne un autre écart", () => {
    const cle = (c: "client" | "ancien_client") => comparer({ ...vide, organisations: [org(T1, S1, c)], hub: [hub("a1", T1, S1, "prospect")], crm: [crm("c1", S1)] })[0]!.cle;
    expect(cle("client")).not.toBe(cle("ancien_client"));
    expect(cle("client")).toContain("client_actif");
  });

  it("[C-364] proposition périmée, valeur changée : la ligne ouverte dont la clé n'est plus produite est fermée (resolu:nuit) et la nouvelle est créée", async () => {
    const m = memoire();
    const nuit = (c: "client" | "ancien_client") => lancerNuit({ lire: async () => ({ ...vide, organisations: [org(T1, S1, c)], hub: [hub("a1", T1, S1, "prospect")], crm: [crm("c1", S1)] }), ecrivain: m.e });
    await nuit("client");
    const r = await nuit("ancien_client");
    expect(r).toMatchObject({ crees: 1, fermees: 1 });
    expect(m.lignes.map((l) => [l.etat, l.decision])).toEqual([["tranche", "resolu:nuit"], ["ouvert", null]]);
    expect(m.lignes[0]!.cle).not.toBe(m.lignes[1]!.cle);
  });

  it("[C-364] proposition périmée, écart disparu : la ligne ouverte est fermée (resolu:nuit), même pour un client sans aucun écart cette nuit", async () => {
    const m = memoire();
    await lancerNuit({ lire: async () => ({ ...vide, organisations: [org(T1, S1, "client")], hub: [hub("a1", T1, S1, "prospect")], crm: [crm("c1", S1)] }), ecrivain: m.e });
    const r = await lancerNuit({ lire: async () => ({ ...vide, organisations: [org(T1, S1, "client")], hub: [hub("a1", T1, S1, "client_actif")], crm: [crm("c1", S1)] }), ecrivain: m.e });
    expect(r).toMatchObject({ crees: 0, fermees: 1 });
    expect(m.lignes).toMatchObject([{ etat: "tranche", decision: "resolu:nuit" }]);
  });

  it("[C-364] une ligne déjà tranchée (écartée) dont l'écart persiste est recréée la nuit suivante : choix voulu, l'écart reste visible", async () => {
    const m = memoire();
    await lancerNuit({ lire: async () => entree, ecrivain: m.e });
    m.lignes[0]!.etat = "tranche";
    m.lignes[0]!.decision = "ecarte:essai";
    await lancerNuit({ lire: async () => entree, ecrivain: m.e });
    expect(m.lignes.map((l) => l.etat)).toEqual(["tranche", "ouvert"]);
  });

  it("[C-364] rattrapage : une nuit interrompue en route puis relancée crée les lignes manquantes, sans doublon", async () => {
    const m = memoire();
    const deuxClients: EntreeComparaison = { ...vide, organisations: [org(T1, S1), org(T2, S2)], hub: [hub("a1", T1, S1, "prospect"), hub("a2", T2, S2, "prospect")], crm: [crm("c1", S1), crm("c2", S2)] };
    let n = 0;
    const casse: Ecrivain = { ...m.e, inserer: async (t, l) => { if (n++ === 1) throw new Error("panne"); return m.e.inserer(t, l); } };
    await expect(lancerNuit({ lire: async () => deuxClients, ecrivain: casse })).rejects.toThrow("panne");
    expect(m.lignes).toHaveLength(1);
    const r = await lancerNuit({ lire: async () => deuxClients, ecrivain: m.e });
    expect(r).toMatchObject({ crees: 1, dejaOuverts: 1 });
    expect(m.lignes.map((l) => l.tenantId).sort()).toEqual([T1, T2]);
  });

  it("[C-364] la clé d'un écart numero_en_double est propre à chaque client : un autre numéro donne un autre écart", () => {
    const cle = (n: string) => comparer({ ...vide, numeros: [{ tenantId: T1, numero: n, nature: "facture" }, { tenantId: T2, numero: n, nature: "facture" }] })[0]!.cle;
    expect(cle("F-1")).not.toBe(cle("F-2"));
  });

  it("[C-364] un écart sans client de la console est rendu dans le rapport, pas perdu", async () => {
    const { e, inseres } = ecrivain();
    const r = await lancerNuit({ lire: async () => ({ ...vide, hub: [hub("a2", null, S2)] }), ecrivain: e });
    expect(inseres).toEqual([]);
    expect(r.sansClient.map((x) => x.type)).toEqual(["absent_console"]);
  });

  it("[C-364] demander_fusion_crm ne choisit pas la fiche gardée : le choix reste à l'équipe", () => {
    const e = comparer({ ...vide, organisations: [org(T1, S1)], hub: [hub("a1", T1, S1)], crm: [crm("c2", S1), crm("c1", S1)] });
    expect(e.find((x) => x.type === "double_crm")?.proposition).toMatchObject({ action: "demander_fusion_crm", apres: { gardee: null } });
  });

  it("[C-364] la tâche de nuit a pour identifiant la date, et se rejoue 3 fois avec attente croissante ; une date invalide est refusée", async () => {
    const ajouts: { nom: string; opts: unknown }[] = [];
    const file = { add: async (nom: string, _d: unknown, opts: unknown) => { ajouts.push({ nom, opts }); } };
    await planifierNuit(file, "2026-11-02");
    expect(ajouts).toEqual([{ nom: "coherence-nuit", opts: { jobId: "2026-11-02", attempts: 3, backoff: { type: "exponential", delay: 60_000 } } }]);
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
    const maj = [...a.matchAll(/\bUPDATE\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(maj.length).toBeGreaterThan(0);
    expect(new Set(maj)).toEqual(new Set(["a_trancher"]));
  });
});
