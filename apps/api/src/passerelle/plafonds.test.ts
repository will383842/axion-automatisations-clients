import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { journalEnMemoire } from "../journal-audit/port.js";
import { chargerPlafonds, ConfigPlafondsInvalide } from "./plafonds.config.js";
import { creerBudgetJour, creerPlafonds, ErreurPlafonds } from "./plafonds.js";

const A = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const URL_P = "http://passerelle.test:4000";
const MAITRE = `TEST-NE-PAS-UTILISER-maitre-${randomUUID()}`;
const PLAFOND_TEST = 1_000_000; // micro-centimes, fictif
const ADMIN = "admin-test";
const ENV_OK = { PLAFOND_CLE_CLIENT_MICROCENTIMES: "1000000", PLAFOND_PASSERELLE_JOUR_MICROCENTIMES: "5000000", SEUIL_RYTHME_ANORMAL: "5" };

interface CleFausse { token: string; alias: string; tenant: string; spend: number; maxBudget?: number | undefined; duree?: string | undefined; bloquee: boolean }
interface Appel { methode: string; url: string; corps: string; auth: string | null; redirect: string | undefined }
// Imitation de la passerelle : chemins de LiteLLM (/key/list, /key/info, /key/update, /key/block, /key/unblock), clé maîtresse exigée.
function fausse() {
  const etat = { appels: [] as Appel[], cles: new Map<string, CleFausse>(), reponse: undefined as undefined | ((u: string) => Response | undefined), panne: false };
  const ajouter = (tenant: string, alias = `cli-${tenant}`, spend = 0) => {
    const token = randomUUID().replaceAll("-", "").padEnd(64, "a");
    etat.cles.set(token, { token, alias, tenant, spend, bloquee: false });
    return token;
  };
  const fetchImitation: typeof fetch = async (entree, init) => {
    const url = String(entree);
    const corps = typeof init?.body === "string" ? init.body : "";
    etat.appels.push({ methode: init?.method ?? "GET", url, corps, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${MAITRE}`) return new Response("{}", { status: 401 });
    if (etat.panne) return new Response("{}", { status: 503 });
    const forcee = etat.reponse?.(url);
    if (forcee) return forcee;
    const u = new URL(url);
    const json = corps ? (JSON.parse(corps) as { key?: string; max_budget?: number; budget_duration?: string }) : {};
    if (u.pathname === "/key/list") {
      const alias = u.searchParams.get("key_alias");
      const keys = [...etat.cles.values()].filter((c) => c.alias === alias).map((c) => ({ token: c.token, key_alias: c.alias, metadata: { tenant_id: c.tenant } }));
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }
    if (u.pathname === "/key/info") {
      const c = etat.cles.get(u.searchParams.get("key") ?? "");
      return c ? new Response(JSON.stringify({ info: { token: c.token, spend: c.spend, blocked: c.bloquee, max_budget: c.maxBudget ?? null } }), { status: 200 }) : new Response("{}", { status: 404 });
    }
    const c = etat.cles.get(json.key ?? "");
    if (!c) return new Response("{}", { status: 404 });
    if (u.pathname === "/key/update") {
      c.maxBudget = json.max_budget;
      c.duree = json.budget_duration;
    } else if (u.pathname === "/key/block") c.bloquee = true;
    else if (u.pathname === "/key/unblock") c.bloquee = false;
    return new Response("{}", { status: 200 });
  };
  return { etat, ajouter, fetchImitation };
}
let f: ReturnType<typeof fausse>;
let journal: ReturnType<typeof journalEnMemoire>;
let admins: Set<string>;
const monter = (opts: { journalPanne?: boolean } = {}) =>
  creerPlafonds({
    url: URL_P,
    lireCleMaitre: async () => MAITRE,
    journal: opts.journalPanne ? { ecrire: async () => { throw new Error("journal en panne"); } } : journal,
    estAdministrateur: async (id) => admins.has(id),
    plafondCleMax: PLAFOND_TEST,
    fetch: f.fetchImitation,
  });
const refus = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurPlafonds);
  if (code) expect((e as ErreurPlafonds).code).toBe(code);
};
beforeEach(() => { f = fausse(); journal = journalEnMemoire(); admins = new Set([ADMIN]); });

describe("plafonds : clé d'un client", () => {
  it("[C-437] poserPlafondCle règle max_budget (unités) et un budget mensuel sur la clé du client seulement", async () => {
    const tA = f.ajouter(A);
    const tB = f.ajouter(B);
    await monter().poserPlafondCle(A, 450_000);
    expect(f.etat.cles.get(tA)).toMatchObject({ maxBudget: 0.0045, duree: "30d" });
    expect(f.etat.cles.get(tB)?.maxBudget).toBeUndefined();
    expect(f.etat.appels.every((a) => a.auth === `Bearer ${MAITRE}` && a.redirect === "error")).toBe(true);
  });
  it("[C-437] @argent attaque : plafond négatif, nul, décimal, texte, infini, NaN ou hors entier sûr refusé sans appel", async () => {
    f.ajouter(A);
    for (const m of [-1, 0, 0.5, Number.NaN, Infinity, 2 ** 53, "100", null, undefined]) await refus(monter().poserPlafondCle(A, m as number), "montant_invalide");
    expect(f.etat.appels).toEqual([]);
  });
  it("[C-437] @argent attaque : plafond au-dessus du maximum configuré refusé sans appel", async () => {
    f.ajouter(A);
    await refus(monter().poserPlafondCle(A, PLAFOND_TEST + 1), "montant_invalide");
    expect(f.etat.appels).toEqual([]);
  });
  it("[C-437] @isolation attaque : identifiant de client forgé refusé sans appel", async () => {
    for (const t of ["", "../x", `${A}/../${B}`, `${A}","models":[]`, "cli-x", ` ${A}`]) {
      await refus(monter().poserPlafondCle(t, 1000), "tenant_invalide");
      await refus(monter().bloquerCle(t, "motif"), "tenant_invalide");
      await refus(monter().leverBlocage(t, { parQui: ADMIN, motif: "motif" }), "tenant_invalide");
    }
    expect(f.etat.appels).toEqual([]);
  });
  it("[C-437] @isolation attaque : la passerelle renvoie la clé d'un autre client sous l'alias demandé → refus, rien n'est modifié", async () => {
    const tB = f.ajouter(B, `cli-${A}`);
    await refus(monter().poserPlafondCle(A, 1000), "client_different");
    await refus(monter().bloquerCle(A, "motif"), "client_different");
    expect(f.etat.cles.get(tB)).toMatchObject({ bloquee: false });
    expect(f.etat.cles.get(tB)?.maxBudget).toBeUndefined();
  });
  it("[C-437] @isolation attaque : deux clés pour le même alias, ou aucune → refus (jamais de choix au hasard)", async () => {
    await refus(monter().poserPlafondCle(A, 1000), "cle_introuvable");
    f.ajouter(A);
    f.ajouter(A);
    await refus(monter().poserPlafondCle(A, 1000), "cle_ambigue");
    expect([...f.etat.cles.values()].every((c) => c.maxBudget === undefined)).toBe(true);
  });
  it("[C-437] @argent la clé d'un client qui atteint son plafond est refusée, et la clé d'un autre client continue", async () => {
    const tA = f.ajouter(A);
    const tB = f.ajouter(B);
    await monter().bloquerCle(A, "plafond atteint");
    expect(f.etat.cles.get(tA)?.bloquee).toBe(true);
    expect(f.etat.cles.get(tB)?.bloquee).toBe(false);
    expect(journal.entrees).toHaveLength(1);
    expect(journal.entrees[0]).toMatchObject({ action: "blocage_cle", tenantId: A, motif: "plafond atteint" });
  });
  it("[C-437] leverBlocage rouvre la clé et écrit au journal qui, quand et le motif, avec le montant consommé", async () => {
    const tA = f.ajouter(A, `cli-${A}`, 0.0045);
    await monter().bloquerCle(A, "plafond atteint");
    await monter().leverBlocage(A, { parQui: ADMIN, motif: "client prévenu, plafond relevé" });
    expect(f.etat.cles.get(tA)?.bloquee).toBe(false);
    expect(journal.entrees.at(-1)).toMatchObject({ action: "levee_blocage_cle", tenantId: A, parQui: ADMIN, motif: "client prévenu, plafond relevé", montantConsommeMicroCentimes: 450_000 });
    expect(Number.isNaN(Date.parse(journal.entrees.at(-1)?.quand ?? ""))).toBe(false);
  });
  it("[C-437] sans motif, leverBlocage est refusé (vide, blanc, trop long, saut de ligne ou caractère de contrôle)", async () => {
    const t = f.ajouter(A);
    await monter().bloquerCle(A, "plafond atteint");
    for (const motif of ["", "   ", "\t", "x".repeat(501), "ligne\nfausse entrée", "a\u0000b", undefined, 12]) {
      await refus(monter().leverBlocage(A, { parQui: ADMIN, motif: motif as string }), "motif_invalide");
    }
    expect(f.etat.cles.get(t)?.bloquee).toBe(true);
    expect(journal.entrees).toHaveLength(1);
  });
  it("[C-437] @argent attaque : leverBlocage refusé pour qui n'est pas administrateur (vide, inconnu, objet) ; la clé reste bloquée", async () => {
    const t = f.ajouter(A);
    await monter().bloquerCle(A, "plafond atteint");
    for (const p of ["", "client-A", "ADMIN-TEST", { toString: () => ADMIN }]) await refus(monter().leverBlocage(A, { parQui: p as string, motif: "motif" }), "non_administrateur");
    expect(f.etat.cles.get(t)?.bloquee).toBe(true);
    expect(journal.entrees).toHaveLength(1);
  });
  it("[C-437] @argent attaque : journal en panne → pas de levée sans trace, la clé reste bloquée", async () => {
    const t = f.ajouter(A);
    await monter().bloquerCle(A, "plafond atteint");
    await refus(monter({ journalPanne: true }).leverBlocage(A, { parQui: ADMIN, motif: "motif" }), "journal_indisponible");
    expect(f.etat.cles.get(t)?.bloquee).toBe(true);
  });
  it("[C-437] attaque : passerelle en panne → le blocage échoue bruyamment (jamais « bloqué » sans l'être)", async () => {
    f.ajouter(A);
    f.etat.panne = true;
    await refus(monter().bloquerCle(A, "motif"), "passerelle_indisponible");
    expect(journal.entrees).toEqual([]);
  });
  it("[C-437] attaque : réponse de la passerelle mal formée (dépense négative, texte) → refus à la levée", async () => {
    f.ajouter(A);
    for (const spend of [-1, "9", null]) {
      f.etat.reponse = (u) => (u.includes("/key/info") ? new Response(JSON.stringify({ info: { spend } }), { status: 200 }) : undefined);
      await refus(monter().leverBlocage(A, { parQui: ADMIN, motif: "motif" }), "reponse_invalide");
    }
    expect(journal.entrees).toEqual([]);
  });
  it("[C-437] @argent attaque : la lecture de la dépense échoue (5xx, null, mal formée) → la clé est QUAND MÊME bloquée, le montant est noté illisible", async () => {
    for (const lecture of [() => new Response("{}", { status: 503 }), () => new Response(JSON.stringify({ info: { spend: null } }), { status: 200 }), () => new Response("pas du json", { status: 200 })]) {
      const t = f.ajouter(A);
      f.etat.reponse = (u) => (u.includes("/key/info") ? lecture() : undefined);
      await monter().bloquerCle(A, "clé volée");
      expect(f.etat.cles.get(t)?.bloquee).toBe(true);
      expect(journal.entrees.at(-1)).toMatchObject({ action: "blocage_cle", tenantId: A, motif: "clé volée" });
      expect(journal.entrees.at(-1)?.montantConsommeMicroCentimes).toBeUndefined();
      f.etat.cles.clear();
      journal.entrees.length = 0;
    }
  });
  it("[C-437] attaque : /key/unblock échoue après la trace → la trace dit « levée échouée », pas « levée »", async () => {
    f.ajouter(A);
    await monter().bloquerCle(A, "plafond atteint");
    f.etat.reponse = (u) => (u.includes("/key/unblock") ? new Response("{}", { status: 503 }) : undefined);
    await refus(monter().leverBlocage(A, { parQui: ADMIN, motif: "motif" }), "passerelle_indisponible");
    expect(journal.entrees.at(-1)).toMatchObject({ action: "levee_blocage_cle_echouee", tenantId: A });
  });
  it("[C-437] aucune levée automatique : bloquer deux fois ne rouvre rien et rien d'autre n'appelle /key/unblock", async () => {
    const t = f.ajouter(A);
    await monter().bloquerCle(A, "un");
    await monter().bloquerCle(A, "deux");
    expect(f.etat.cles.get(t)?.bloquee).toBe(true);
    expect(f.etat.appels.some((a) => a.url.includes("unblock"))).toBe(false);
  });
});

describe("plafonds : budget global du jour", () => {
  let maintenant: Date;
  const jour = (plafond = 1000) => creerBudgetJour({ plafond, journal, estAdministrateur: async (id) => admins.has(id), horloge: () => maintenant });
  beforeEach(() => { maintenant = new Date("2030-01-01T10:00:00Z"); });
  it("[C-598] @argent budget global du jour atteint → la passerelle refuse pour toutes les clés ; après la période elle rouvre", () => {
    const b = jour();
    expect(b.reserver(600)).toBe(true);
    expect(b.reserver(400)).toBe(true);
    expect(b.reserver(1)).toBe(false);
    expect(b.reserver(0)).toBe(false);
    maintenant = new Date("2030-01-02T00:00:00Z");
    expect(b.reserver(1)).toBe(true);
  });
  it("[C-598] @argent attaque : un appel qui ferait dépasser le budget est refusé en entier (pas de dépassement d'un appel)", () => {
    const b = jour();
    expect(b.reserver(999)).toBe(true);
    expect(b.reserver(2)).toBe(false);
    expect(b.reserver(1)).toBe(true);
  });
  it("[C-598] @argent attaque : coût négatif, NaN, infini, décimal ou texte ne fait jamais baisser le compteur", () => {
    const b = jour();
    expect(b.reserver(1000)).toBe(true);
    for (const c of [-500, Number.NaN, Infinity, 0.5, "1", null]) expect(() => b.reserver(c as number)).toThrow(ErreurPlafonds);
    expect(b.reserver(1)).toBe(false);
  });
  it("[C-598] @argent attaque : une horloge qui recule ne rouvre pas le budget du jour", () => {
    const b = jour();
    b.reserver(1000);
    maintenant = new Date("2029-12-31T23:00:00Z");
    expect(b.reserver(1)).toBe(false);
    maintenant = new Date(Number.NaN);
    expect(() => b.reserver(1)).toThrow(ErreurPlafonds);
  });
  it("[C-598] @argent attaque : horloge illisible dès le premier appel → refus, pas de remise à zéro silencieuse", () => {
    maintenant = new Date(Number.NaN);
    const b = jour();
    expect(() => b.reserver(1)).toThrow(ErreurPlafonds);
    maintenant = new Date("2030-01-01T00:00:00Z");
    expect(b.reserver(1000)).toBe(true);
    expect(b.reserver(1)).toBe(false);
  });
  it("[C-598] la levée du budget du jour est réservée à l'administrateur, motivée et tracée", async () => {
    const b = jour();
    b.reserver(1000);
    await refus(b.lever({ parQui: "inconnu", motif: "motif" }), "non_administrateur");
    await refus(b.lever({ parQui: ADMIN, motif: " " }), "motif_invalide");
    expect(b.reserver(1)).toBe(false);
    await b.lever({ parQui: ADMIN, motif: "journée exceptionnelle" });
    expect(b.reserver(1)).toBe(true);
    expect(journal.entrees.at(-1)).toMatchObject({ action: "levee_budget_jour", parQui: ADMIN, motif: "journée exceptionnelle", montantConsommeMicroCentimes: 1000 });
  });
  it("[C-598] attaque : budget du jour mal défini (nul, négatif, décimal) refusé à la création", () => {
    for (const p of [0, -1, 0.5, Number.NaN, Infinity]) expect(() => jour(p)).toThrow(ErreurPlafonds);
  });
  it("[C-598] la configuration de la passerelle porte un budget global d'un jour, fictif, sans valeur réelle", async () => {
    const nom = "js-yaml";
    const { load } = (await import(nom)) as unknown as { load: (t: string) => unknown };
    const racine = fileURLToPath(new URL("../../../../ops/socle/litellm/config.yaml", import.meta.url));
    const cfg = load(readFileSync(racine, "utf8")) as { litellm_settings: { max_budget?: unknown; budget_duration?: unknown } };
    expect(cfg.litellm_settings.budget_duration).toBe("1d");
    expect(typeof cfg.litellm_settings.max_budget === "number" && cfg.litellm_settings.max_budget > 0).toBe(true);
  });
});

describe("plafonds : configuration", () => {
  it("[C-598] en production, l'API refuse de démarrer sans plafonds définis, sans montrer de valeur", () => {
    expect(() => chargerPlafonds({ NODE_ENV: "production" })).toThrow(ConfigPlafondsInvalide);
    const e = (() => { try { chargerPlafonds({ NODE_ENV: "production", PLAFOND_CLE_CLIENT_MICROCENTIMES: "12345" }); } catch (x) { return x as Error; } })();
    expect(e?.message).toContain("PLAFOND_PASSERELLE_JOUR_MICROCENTIMES");
    expect(e?.message).not.toContain("12345");
  });
  it("[C-598] attaque : valeurs vides, nulles, négatives, décimales, en notation scientifique, hexa, avec espace ou hors entier sûr refusées", () => {
    for (const v of ["", "0", "-5", "1.5", "1e6", "0x10", " 5", "5 ", "007", "NaN", "Infinity", "9007199254740993", "1,000"]) {
      expect(() => chargerPlafonds({ ...ENV_OK, PLAFOND_CLE_CLIENT_MICROCENTIMES: v })).toThrow(ConfigPlafondsInvalide);
      expect(() => chargerPlafonds({ ...ENV_OK, PLAFOND_PASSERELLE_JOUR_MICROCENTIMES: v })).toThrow(ConfigPlafondsInvalide);
    }
  });
  it("[C-598] attaque : un seuil de rythme ≤ 1, infini ou illisible refusé (il alerterait toujours ou jamais)", () => {
    for (const v of ["", "1", "0.5", "-2", "Infinity", "abc", "1e400"]) expect(() => chargerPlafonds({ ...ENV_OK, SEUIL_RYTHME_ANORMAL: v })).toThrow(ConfigPlafondsInvalide);
  });
  it("[C-598] des valeurs correctes donnent les trois plafonds", () => {
    expect(chargerPlafonds({ ...ENV_OK, SEUIL_RYTHME_ANORMAL: "2.5" })).toEqual({ cleClientMicroCentimes: 1_000_000, passerelleJourMicroCentimes: 5_000_000, seuilRythmeAnormal: 2.5 });
  });
});
