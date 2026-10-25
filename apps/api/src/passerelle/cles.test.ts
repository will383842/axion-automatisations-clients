import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { creerCles, ErreurPasserelle, MODELES_PERMIS } from "./cles.js";

const A = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const URL_P = "http://passerelle.test:4000";
const MAITRE = `TEST-NE-PAS-UTILISER-maitre-${randomUUID()}`;

interface Appel { methode: string; url: string; corps: string; auth: string | null; redirect: string | undefined }
// Imitation de la passerelle : mêmes chemins que LiteLLM (/key/generate, /key/delete), clé maîtresse exigée.
function fausse() {
  const etat = { appels: [] as Appel[], cles: new Map<string, string>(), reponse: undefined as undefined | (() => Response), panneCoffre: false, rangees: [] as { tenant: string; valeur: string }[] };
  const fetchImitation: typeof fetch = async (entree, init) => {
    const corps = typeof init?.body === "string" ? init.body : "";
    const auth = new Headers(init?.headers).get("authorization");
    etat.appels.push({ methode: init?.method ?? "GET", url: String(entree), corps, auth, redirect: init?.redirect });
    if (auth !== `Bearer ${MAITRE}`) return new Response("{}", { status: 401 });
    if (etat.reponse) return etat.reponse();
    const json = JSON.parse(corps) as { key_alias?: string; key_aliases?: string[] };
    if (String(entree).endsWith("/key/generate")) {
      const cle = `sk-${randomUUID()}`;
      etat.cles.set(json.key_alias ?? "", cle);
      return new Response(JSON.stringify({ key: cle, key_alias: json.key_alias }), { status: 200 });
    }
    for (const a of json.key_aliases ?? []) etat.cles.delete(a);
    return new Response(JSON.stringify({ deleted_keys: json.key_aliases }), { status: 200 });
  };
  const coffre = {
    async rangerIdentifiant(tenant: string, _nom: string, valeur: string) {
      if (etat.panneCoffre) throw new Error(`coffre en panne pour ${valeur}`);
      etat.rangees.push({ tenant, valeur });
      return `bao:clients/${tenant}/${randomUUID()}`;
    },
  };
  const cles = creerCles({ url: URL_P, lireCleMaitre: async () => MAITRE, coffre, fetch: fetchImitation });
  return { etat, cles };
}
let f: ReturnType<typeof fausse>;
beforeEach(() => { f = fausse(); });
const refus = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurPasserelle);
  if (code) expect((e as ErreurPasserelle).code).toBe(code);
  return e as ErreurPasserelle;
};

describe("passerelle : clés virtuelles des clients", () => {
  it("[A-058] une clé par client : alias cli-<tenantId>, metadata.tenant_id et modèles permis envoyés à /key/generate", async () => {
    await f.cles.creerCleClient(A, { modelesPermis: ["claude-standard"] });
    const a = f.etat.appels[0] as Appel;
    expect(a.url).toBe(`${URL_P}/key/generate`);
    expect(JSON.parse(a.corps)).toMatchObject({ key_alias: `cli-${A}`, metadata: { tenant_id: A }, models: ["claude-standard"] });
  });
  it("[A-058] la valeur de la clé va au coffre ; le résultat ne porte que la référence", async () => {
    const r = await f.cles.creerCleClient(A, { modelesPermis: [...MODELES_PERMIS] });
    expect(r.reference).toMatch(new RegExp(`^bao:clients/${A}/`));
    expect(f.etat.rangees).toEqual([{ tenant: A, valeur: f.etat.cles.get(`cli-${A}`) }]);
    expect(JSON.stringify(r)).not.toContain(f.etat.cles.get(`cli-${A}`) as string);
  });
  it("[A-058] attaque : liste de modèles vide (LiteLLM la lit comme « tous les modèles ») refusée sans appel", async () => {
    await refus(f.cles.creerCleClient(A, { modelesPermis: [] }), "modeles_invalides");
    expect(f.etat.appels).toEqual([]);
  });
  it("[A-058] attaque : jokers et modèles hors des trois familles refusés sans appel", async () => {
    for (const m of ["*", "all-proxy-models", "all-team-models", "gpt-4", "claude-standard,gpt-option", "claude-*"]) {
      await refus(f.cles.creerCleClient(A, { modelesPermis: ["claude-standard", m] }), "modeles_invalides");
    }
    await refus(f.cles.creerCleClient(A, { modelesPermis: "claude-standard" as unknown as string[] }), "modeles_invalides");
    expect(f.etat.appels).toEqual([]);
  });
  it("[A-058] @isolation attaque : identifiant de client forgé (chemin, alias, injection) refusé sans appel", async () => {
    for (const t of ["", "../x", `${A}/../${B}`, `${A}\",\"models\":[]`, "cli-x", A.toUpperCase().slice(0, 30), ` ${A}`]) {
      await refus(f.cles.creerCleClient(t, { modelesPermis: ["claude-standard"] }), "tenant_invalide");
      await refus(f.cles.revoquerCle(t), "tenant_invalide");
    }
    expect(f.etat.appels).toEqual([]);
  });
  it("[A-058] attaque : coffre en panne après la génération → la clé orpheline vivante est révoquée, la valeur n'apparaît dans aucune erreur", async () => {
    f.etat.panneCoffre = true;
    const e = await refus(f.cles.creerCleClient(A, { modelesPermis: ["claude-standard"] }), "coffre_indisponible");
    expect(f.etat.cles.size).toBe(0);
    expect(JSON.parse((f.etat.appels.at(-1) as Appel).corps)).toEqual({ key_aliases: [`cli-${A}`] });
    expect(`${e.message}${JSON.stringify(e)}${e.stack}`).not.toMatch(/sk-/);
  });
  it("[C-598] attaque : la clé maîtresse ne voyage qu'en en-tête vers la passerelle, jamais dans l'adresse ni le corps, et aucune redirection n'est suivie", async () => {
    await f.cles.creerCleClient(A, { modelesPermis: ["claude-standard"] });
    await f.cles.revoquerCle(A);
    for (const a of f.etat.appels) {
      expect(a.url.startsWith(URL_P)).toBe(true);
      expect(a.url + a.corps).not.toContain(MAITRE);
      expect(a.redirect).toBe("error");
    }
  });
  it("[A-058] attaque : message d'erreur de la passerelle qui recopie une clé → l'erreur ne garde que le code", async () => {
    f.etat.reponse = () => new Response(`erreur sk-secret-${MAITRE}`, { status: 500 });
    const e = await refus(f.cles.creerCleClient(A, { modelesPermis: ["claude-standard"] }), "passerelle_indisponible");
    expect(e.message).toBe("passerelle_indisponible");
    expect(f.etat.rangees).toEqual([]);
  });
  it("[A-058] attaque : réponse sans clé valide → rien n'est rangé", async () => {
    for (const corps of [{}, { key: "" }, { key: 42 }, { key: "pas-une-cle" }]) {
      f.etat.reponse = () => new Response(JSON.stringify(corps), { status: 200 });
      await refus(f.cles.creerCleClient(A, { modelesPermis: ["claude-standard"] }), "reponse_invalide");
    }
    expect(f.etat.rangees).toEqual([]);
  });
  it("[A-058] @isolation révoquer un client n'envoie que son alias, jamais celui d'un autre", async () => {
    await f.cles.creerCleClient(A, { modelesPermis: ["claude-standard"] });
    await f.cles.creerCleClient(B, { modelesPermis: ["claude-standard"] });
    await f.cles.revoquerCle(A);
    expect(JSON.parse((f.etat.appels.at(-1) as Appel).corps)).toEqual({ key_aliases: [`cli-${A}`] });
    expect([...f.etat.cles.keys()]).toEqual([`cli-${B}`]);
  });
  it("[C-598] clé maîtresse illisible dans le coffre → aucun appel, code précis", async () => {
    const c = creerCles({ url: URL_P, lireCleMaitre: async () => { throw new Error("scellé"); }, coffre: { rangerIdentifiant: async () => "x" }, fetch: f.etat.reponse as never });
    await refus(c.creerCleClient(A, { modelesPermis: ["claude-standard"] }), "cle_maitresse_indisponible");
    expect(f.etat.appels).toEqual([]);
  });
});
