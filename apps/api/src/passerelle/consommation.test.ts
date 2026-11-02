import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { creerConsommation, ErreurConsommation, MICRO_CENTIMES_PAR_UNITE } from "./consommation.js";

const A = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const URL_P = "http://passerelle.test:4000";
const TAUX_FICTIF = 0.0001; // le même nombre rond que ops/socle/litellm/config.yaml, marqué fictif
const REF_A = `bao:clients/${A}/${randomUUID()}`;
const REF_B = `bao:clients/${B}/${randomUUID()}`;
const CLE_A = `sk-TEST-NE-PAS-UTILISER-${randomUUID()}`;
const CLE_B = `sk-TEST-NE-PAS-UTILISER-${randomUUID()}`;
const CLE_EQUIPE = `sk-TEST-NE-PAS-UTILISER-${randomUUID()}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const EMPREINTE_A = sha256(CLE_A); // l'empreinte que la passerelle garde dans son journal de dépense (jamais la clé elle-même)
const EMPREINTE_B = sha256(CLE_B);

// FORME RÉELLE d'une ligne de /spend/logs : les champs de la table LiteLLM_SpendLogs de la version épinglée (ops/briques/litellm.json).
// Valeurs fictives ; seule l'empreinte est remplacée ici par celle de la clé d'essai. L'essai d'intégration (tests/audit-1a/passerelle.int.test.ts)
// vérifie que la vraie réponse porte au moins ces champs.
type Ligne = Record<string, unknown>;
const MODELE_LIGNE = (JSON.parse(readFileSync(new URL("./__fixtures__/spend-logs.reponse.json", import.meta.url), "utf8")) as Ligne[])[0] as Ligne;
const ligne = (entree: number, sortie: number, empreinte = EMPREINTE_A, plus: Ligne = {}): Ligne => ({
  ...MODELE_LIGNE,
  api_key: empreinte,
  spend: (entree + sortie) * TAUX_FICTIF,
  prompt_tokens: entree,
  completion_tokens: sortie,
  total_tokens: entree + sortie,
  ...plus,
});
const lignes = (n: number, entree: number, sortie: number, empreinte = EMPREINTE_A) => Array.from({ length: n }, () => ligne(entree, sortie, empreinte));

interface Appel { url: string; auth: string | null; redirect: string | undefined }
let appels: Appel[];
let journal: () => unknown;
let statut: number;
const coffre = {
  async lireValeur(tenant: string, ref: string) {
    if (!ref.startsWith(`bao:clients/${tenant}/`)) throw new Error("reference_etrangere");
    return ref === REF_A ? CLE_A : CLE_B;
  },
};
const fetchImitation: typeof fetch = async (entree, init) => {
  appels.push({ url: String(entree), auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
  if (!String(entree).startsWith(`${URL_P}/spend/logs?`)) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(journal()), { status: statut });
};
const c = (extra: Partial<Parameters<typeof creerConsommation>[0]> = {}) =>
  creerConsommation({ url: URL_P, coffre, lireCleEquipe: async () => CLE_EQUIPE, fetch: fetchImitation, ...extra });
const refus = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurConsommation);
  expect((e as ErreurConsommation).code).toBe(code);
  return e as ErreurConsommation;
};
beforeEach(() => { appels = []; statut = 200; journal = () => lignes(3, 10, 5); });

describe("passerelle : consommation d'un client", () => {
  it("[A-059] @argent après 3 appels de 10 + 5 jetons, le coût en micro-centimes entiers vaut jetons × taux fictif", async () => {
    const r = await c().lire(A, REF_A);
    expect(r).toEqual({ jetonsEntree: 30, jetonsSortie: 15, coutMicroCentimes: Math.round(45 * TAUX_FICTIF * MICRO_CENTIMES_PAR_UNITE) });
    expect(r.coutMicroCentimes).toBe(450_000);
  });
  it("[A-059] @argent un client sans aucun appel a une consommation nulle", async () => {
    journal = () => [];
    expect(await c().lire(A, REF_A)).toEqual({ jetonsEntree: 0, jetonsSortie: 0, coutMicroCentimes: 0 });
  });
  it("[A-059] @argent attaque : l'erreur d'arrondi des flottants ne décale jamais un montant (0,1 + 0,2)", async () => {
    journal = () => [ligne(1, 1, EMPREINTE_A, { spend: 0.1 + 0.2 })];
    expect((await c().lire(A, REF_A)).coutMicroCentimes).toBe(30_000_000);
  });
  it("[A-059] @argent attaque : dépense négative, absente, texte, infinie ou hors entier sûr → refusée", async () => {
    for (const s of [-0.01, null, "1", Number.MAX_VALUE, 1e300, undefined]) {
      journal = () => [ligne(1, 1, EMPREINTE_A, { spend: s })];
      await refus(c().lire(A, REF_A), "reponse_invalide");
    }
  });
  it("[A-059] @argent attaque : jetons négatifs, décimaux ou textes → refusés (aucun total qui baisse)", async () => {
    for (const l of [{ prompt_tokens: -5, completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: "9", completion_tokens: 1 }, { prompt_tokens: undefined, completion_tokens: 1 }]) {
      journal = () => [ligne(1, 1, EMPREINTE_A, { spend: 0, ...l })];
      await refus(c().lire(A, REF_A), "reponse_invalide");
    }
  });
  it("[A-059] @isolation la lecture se fait avec la clé d'équipe seule : jamais la clé du client, jamais dans l'adresse, un seul chemin", async () => {
    await c().lire(A, REF_A);
    expect(appels).toHaveLength(1);
    const a = appels[0] as Appel;
    expect(a.auth).toBe(`Bearer ${CLE_EQUIPE}`);
    expect(a.url).not.toContain(CLE_A);
    expect(a.url).not.toContain(CLE_EQUIPE);
    expect(a.url.startsWith(`${URL_P}/spend/logs?`)).toBe(true);
    expect(a.redirect).toBe("error");
  });
  it("[A-059] @isolation le journal est demandé pour la seule empreinte SHA-256 de la clé du client, calculée localement", async () => {
    await c().lire(A, REF_A);
    const q = new URL((appels[0] as Appel).url).searchParams;
    expect(q.get("api_key")).toBe(EMPREINTE_A);
    expect(q.get("summarize")).toBe("false");
  });
  it("[A-059] @isolation attaque : la référence du client B demandée pour A est refusée avant tout appel à la passerelle", async () => {
    await refus(c().lire(A, REF_B), "coffre_indisponible");
    expect(appels).toEqual([]);
  });
  it("[A-059] @isolation attaque : une ligne du journal d'un autre client fait échouer la lecture, jamais une somme mélangée", async () => {
    journal = () => [...lignes(3, 10, 5), ...lignes(1, 10, 5, EMPREINTE_B)];
    const e = await refus(c().lire(A, REF_A), "client_different");
    expect(`${e.message}${e.stack}`).not.toContain(EMPREINTE_B);
    journal = () => lignes(2, 10, 5, ""); // empreinte absente : refusée aussi
    await refus(c().lire(A, REF_A), "client_different");
  });
  it("[A-059] @argent attaque : ligne incohérente (dépense sans jeton, ou jetons sans dépense) → refusée", async () => {
    for (const l of [{ spend: 0.0015, prompt_tokens: 0, completion_tokens: 0 }, { spend: 0, prompt_tokens: 4e15, completion_tokens: 0 }]) {
      journal = () => [ligne(0, 0, EMPREINTE_A, l)];
      await refus(c().lire(A, REF_A), "reponse_invalide");
    }
  });
  it("[A-059] @argent les demi-cas ne s'arrondissent pas à l'envers (1,5e-8 → 2 ; 2,95e-7 → 30)", async () => {
    for (const [d, attendu] of [[1.5e-8, 2], [2.95e-7, 30]] as const) {
      journal = () => [ligne(1, 1, EMPREINTE_A, { spend: d })];
      expect((await c().lire(A, REF_A)).coutMicroCentimes).toBe(attendu);
    }
  });
  it("[A-059] la forme réelle d'une réponse de /spend/logs est lue ; une réponse qui n'est pas une liste est refusée", async () => {
    expect(Object.keys(MODELE_LIGNE)).toEqual(expect.arrayContaining(["api_key", "spend", "prompt_tokens", "completion_tokens", "request_id", "startTime"]));
    journal = () => [ligne(10, 5)];
    expect((await c().lire(A, REF_A)).jetonsEntree).toBe(10);
    journal = () => ({ info: { spend: 1 } });
    await refus(c().lire(A, REF_A), "reponse_invalide");
  });
  it("[A-059] @isolation attaque : identifiant de client forgé refusé sans appel", async () => {
    await refus(c().lire("../x", REF_A), "tenant_invalide");
    expect(appels).toEqual([]);
  });
  it("[A-059] la passerelle qui refuse la clé d'équipe (401 ou 403) donne passerelle_indisponible", async () => {
    for (const s of [401, 403, 500]) {
      statut = s;
      await refus(c().lire(A, REF_A), "passerelle_indisponible");
    }
  });
  it("[C-011] la clé d'équipe vient de l'environnement fourni, et son absence ferme la lecture sans appel", async () => {
    await refus(c({ lireCleEquipe: async () => { throw new Error(CLE_EQUIPE); } }).lire(A, REF_A), "cle_equipe_indisponible");
    await refus(c({ lireCleEquipe: async () => "" }).lire(A, REF_A), "cle_equipe_indisponible");
    expect(appels).toEqual([]);
  });
  it("[C-598] attaque : ni la clé du client ni la clé d'équipe n'entrent dans une erreur", async () => {
    journal = () => { throw new Error(`${CLE_A} ${CLE_EQUIPE}`); };
    const e = await refus(c().lire(A, REF_A), "passerelle_indisponible");
    expect(`${e.message}${e.stack}`).not.toContain(CLE_A);
    expect(`${e.message}${e.stack}`).not.toContain(CLE_EQUIPE);
    const f = await refus(c({ lireCleEquipe: async () => { throw new Error(CLE_EQUIPE); } }).lire(A, REF_A), "cle_equipe_indisponible");
    expect(`${f.message}${f.stack}`).not.toContain(CLE_EQUIPE);
  });
});
