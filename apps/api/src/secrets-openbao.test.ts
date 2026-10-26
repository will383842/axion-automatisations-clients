import { describe, expect, it } from "vitest";
import { ErreurCoffre } from "./coffre/coffre.js";
import { creerMasqueur } from "./plugins/journal.js";
import { creerLecteurSecretsOpenBao } from "./secrets-openbao.js";

const MARQUEUR = "MARQUEUR-ESSAI-5e19a0b7c3";
const reponse = (statut: number, corps: unknown) => new Response(typeof corps === "string" ? corps : JSON.stringify(corps), { status: statut });
const options = (fetch: typeof globalThis.fetch, extra = {}) => ({ url: "http://bao.test:8200", jeton: "jeton-essai", fetch, ...extra });
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as ErreurCoffre).code;

describe("LecteurSecrets OpenBao", () => {
  it("[C-011] lire renvoie le champ valeur du secret technique et l'inscrit au masqueur", async () => {
    const appels: string[] = [];
    const masqueur = creerMasqueur();
    const lecteur = creerLecteurSecretsOpenBao(options(async (u) => { appels.push(String(u)); return reponse(200, { data: { data: { valeur: MARQUEUR } } }); }, { masqueur }));
    expect(await lecteur.lire("passerelle/maitre")).toBe(MARQUEUR);
    expect(appels).toEqual(["http://bao.test:8200/v1/technique/data/passerelle/maitre"]);
    expect(masqueur.masquer(`x ${MARQUEUR} y`)).toBe("x [masqué] y");
  });

  it("[C-011] lire refuse un nom hors forme avant tout appel réseau", async () => {
    let appels = 0;
    const lecteur = creerLecteurSecretsOpenBao(options(async () => { appels++; return reponse(200, {}); }));
    for (const nom of ["", "..", "a/../b", "a?x=1", "a%2fb", "A/B", "/a", "a//b", "a/"]) expect(await code(lecteur.lire(nom))).toBe("requete_refusee");
    expect(appels).toBe(0);
  });

  it("[C-011] OpenBao scellé → erreur coffre_scelle", async () => {
    const lecteur = creerLecteurSecretsOpenBao(options(async () => reponse(503, { errors: ["Vault is sealed"] })));
    expect(await code(lecteur.lire("a/b"))).toBe("coffre_scelle");
  });

  it("[C-011] un refus 403 et un secret absent donnent des codes distincts, sans valeur dans le message", async () => {
    expect(await code(creerLecteurSecretsOpenBao(options(async () => reponse(403, { errors: [MARQUEUR] }))).lire("a/b"))).toBe("refuse");
    expect(await code(creerLecteurSecretsOpenBao(options(async () => reponse(404, {}))).lire("a/b"))).toBe("introuvable");
    const e = await creerLecteurSecretsOpenBao(options(async () => reponse(403, { errors: [MARQUEUR] }))).lire("a/b").then(() => undefined, (x: Error) => x);
    expect(e?.message).not.toContain(MARQUEUR);
  });

  it("[C-011] un secret sans champ valeur de type texte est refusé, jamais remplacé par une valeur de repli", async () => {
    for (const corps of [{ data: { data: {} } }, { data: { data: { valeur: 3 } } }, { data: { data: { valeur: "" } } }, {}]) {
      expect(await code(creerLecteurSecretsOpenBao(options(async () => reponse(200, corps))).lire("a/b"))).toBe("coffre_indisponible");
    }
  });
});
