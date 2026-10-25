import { randomUUID } from "node:crypto";
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

interface Appel { url: string; auth: string | null; redirect: string | undefined }
let appels: Appel[];
let info: () => unknown;
let journal: () => unknown;
const coffre = {
  async lireValeur(tenant: string, ref: string) {
    if (!ref.startsWith(`bao:clients/${tenant}/`)) throw new Error("reference_etrangere");
    return ref === REF_A ? CLE_A : CLE_B;
  },
};
const fetchImitation: typeof fetch = async (entree, init) => {
  appels.push({ url: String(entree), auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
  const corps = String(entree).startsWith(`${URL_P}/key/info`) ? info() : journal();
  return new Response(JSON.stringify(corps), { status: 200 });
};
const lignes = (n: number, entree: number, sortie: number) => Array.from({ length: n }, () => ({ prompt_tokens: entree, completion_tokens: sortie }));
const infoDe = (tenant: string, spend: number) => ({ info: { spend, metadata: { tenant_id: tenant }, key_alias: `cli-${tenant}` } });
const c = () => creerConsommation({ url: URL_P, coffre, fetch: fetchImitation });
const refus = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurConsommation);
  expect((e as ErreurConsommation).code).toBe(code);
  return e as ErreurConsommation;
};
beforeEach(() => { appels = []; info = () => infoDe(A, 0.0045); journal = () => lignes(3, 10, 5); });

describe("passerelle : consommation d'un client", () => {
  it("[A-059] @argent après 3 appels de 10 + 5 jetons, le coût en micro-centimes entiers vaut jetons × taux fictif", async () => {
    const r = await c().lire(A, REF_A);
    expect(r).toEqual({ jetonsEntree: 30, jetonsSortie: 15, coutMicroCentimes: Math.round(45 * TAUX_FICTIF * MICRO_CENTIMES_PAR_UNITE) });
    expect(r.coutMicroCentimes).toBe(450_000);
  });
  it("[A-059] @argent attaque : l'erreur d'arrondi des flottants ne décale jamais un montant (0,1 + 0,2)", async () => {
    info = () => infoDe(A, 0.1 + 0.2);
    expect((await c().lire(A, REF_A)).coutMicroCentimes).toBe(30_000_000);
  });
  it("[A-059] @argent attaque : dépense négative, absente, texte, infinie ou hors entier sûr → refusée", async () => {
    for (const s of [-0.01, null, "1", 1e999, 1e300, undefined]) {
      info = () => infoDe(A, s as number);
      await refus(c().lire(A, REF_A), "reponse_invalide");
    }
  });
  it("[A-059] @argent attaque : jetons négatifs, décimaux ou textes → refusés (aucun total qui baisse)", async () => {
    for (const l of [{ prompt_tokens: -5, completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: "9", completion_tokens: 1 }, { prompt_tokens: 1 }]) {
      journal = () => [l];
      await refus(c().lire(A, REF_A), "reponse_invalide");
    }
  });
  it("[A-059] @isolation la lecture de A se fait avec la clé de A seule, placée en en-tête et jamais dans l'adresse", async () => {
    await c().lire(A, REF_A);
    expect(appels.length).toBeGreaterThan(0);
    for (const a of appels) {
      expect(a.auth).toBe(`Bearer ${CLE_A}`);
      expect(a.url).not.toContain(CLE_A);
      expect(a.url.startsWith(URL_P)).toBe(true);
      expect(a.redirect).toBe("error");
    }
  });
  it("[A-059] @isolation attaque : la référence du client B demandée pour A est refusée avant tout appel à la passerelle", async () => {
    await refus(c().lire(A, REF_B), "coffre_indisponible");
    expect(appels).toEqual([]);
  });
  it("[A-059] @isolation attaque : la passerelle répond avec la dépense d'un autre client (metadata ou alias) → refusée", async () => {
    info = () => infoDe(B, 9);
    await refus(c().lire(A, REF_A), "client_different");
    info = () => ({ info: { spend: 1, metadata: { tenant_id: A }, key_alias: `cli-${B}` } });
    await refus(c().lire(A, REF_A), "client_different");
  });
  it("[A-059] @isolation attaque : identifiant de client forgé refusé sans appel", async () => {
    await refus(c().lire("../x", REF_A), "tenant_invalide");
    expect(appels).toEqual([]);
  });
  it("[C-598] attaque : la valeur de la clé n'entre dans aucune erreur", async () => {
    info = () => { throw new Error(CLE_A); };
    const e = await refus(c().lire(A, REF_A), "passerelle_indisponible");
    expect(`${e.message}${e.stack}`).not.toContain(CLE_A);
  });
});
