import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { balayerProvisionnement } from "./declencher.js";
import { coffreOpenBao } from "./etapes-base.js";

const lire = (chemin: string) => readFileSync(new URL(`../../../../${chemin}`, import.meta.url), "utf8");
const CHEMIN = "technique/donnees/cli_0123456789ab/app";

describe("socle du provisionnement", () => {
  it("[A-214] une seule grappe données déclarée en V1, sans adresse ni nom d'hôte", () => {
    const { grappes } = JSON.parse(lire("ops/socle/donnees/grappes.json")) as { grappes: { nom: string }[] };
    expect(grappes.map((g) => g.nom)).toEqual(["donnees-1"]);
    expect(lire("ops/socle/donnees/grappes.json")).not.toMatch(/\d+\.\d+\.\d+\.\d+|:\/\//);
  });

  it("[A-216] la politique provisionneur écrit sans relire les mots de passe des clients, et seul initialiser.sh la pose", () => {
    const hcl = lire("ops/socle/openbao/politiques/provisionneur.hcl");
    expect(hcl).toMatch(/path "technique\/data\/donnees\/cli_\*" \{\s*capabilities = \["create", "update"\]/);
    expect(hcl).not.toMatch(/"technique\/data\/donnees\/cli_\*" \{[^}]*"read"/);
    expect(hcl).not.toMatch(/"(delete|sudo|list)"/);
    expect(lire("ops/socle/openbao/initialiser.sh")).toContain("politiques/provisionneur.hcl");
    expect(lire("apps/api/src/provisionnement/etapes-base.ts")).not.toMatch(/transit\//);
  });

  it("[A-216] le coffre n'écrit que sous technique/donnees/cli_<id>/<rôle>, avec le jeton en en-tête, et ne reprend jamais le corps d'une erreur", async () => {
    const vus: { url: string; init: RequestInit }[] = [];
    const reponse = (statut: number, corps = "") => (async (url: string | URL | Request, init?: RequestInit) => { vus.push({ url: String(url), init: init ?? {} }); return new Response(corps === "" ? null : corps, { status: statut }); }) as typeof fetch;
    const c = coffreOpenBao({ url: "http://coffre.test", jeton: "jeton-d-essai", fetch: reponse(204) });
    await c.ranger(CHEMIN, "valeur-d-essai");
    expect(vus[0]?.url).toBe("http://coffre.test/v1/technique/data/donnees/cli_0123456789ab/app");
    expect((vus[0]?.init.headers as Record<string, string>)["X-Vault-Token"]).toBe("jeton-d-essai");
    for (const mauvais of ["technique/donnees/../clients/x/app", "technique/donnees/cli_0123456789ab/autre", "clients/cli_0123456789ab/app"]) await expect(c.existe(mauvais)).rejects.toMatchObject({ code: "chemin_refuse" });
    const refus = coffreOpenBao({ url: "http://coffre.test", jeton: "j", fetch: reponse(500, "valeur-d-essai") });
    await expect(refus.ranger(CHEMIN, "valeur-d-essai")).rejects.not.toThrow(/valeur-d-essai/);
    expect(await coffreOpenBao({ url: "http://coffre.test", jeton: "j", fetch: reponse(404) }).existe(CHEMIN)).toBe(false);
  });

  it("[C-498] le balayage redépose chaque base encore en_creation (même identifiant de tâche)", async () => {
    const deposes: string[] = [];
    const a = "11111111-1111-4111-8111-111111111111";
    expect(await balayerProvisionnement({ enCreation: async () => [a], deposer: async (t) => void deposes.push(t) })).toBe(1);
    expect(deposes).toEqual([a]);
    await expect(balayerProvisionnement({ enCreation: async () => ["x'--"], deposer: async () => undefined })).rejects.toThrow();
  });
});
