import { describe, expect, it } from "vitest";
import { creerLecteurSecretsOpenBao } from "./secrets-openbao.js";

// Dette T2-34 n° 4 : les secrets des bases clients s'appellent technique/donnees/cli_<12 hex>/app (trait bas).
function lecteur() {
  const urls: string[] = [];
  const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ data: { data: { valeur: "0123456789abcdef0123456789abcdef" } } }), { status: 200 }); }) as unknown as typeof fetch;
  return { urls, lecteur: creerLecteurSecretsOpenBao({ url: "http://bao.test", jeton: "jeton-essai", fetch: f }) };
}
describe("lecture des secrets des bases clients", () => {
  it("[A-216] le secret donnees/cli_<12 hex>/app se lit (le courtier de T2-36 en dépend)", async () => {
    const l = lecteur();
    await expect(l.lecteur.lire("donnees/cli_0123456789ab/app")).resolves.toHaveLength(32);
    expect(l.urls[0]).toBe("http://bao.test/v1/technique/data/donnees/cli_0123456789ab/app");
  });
  it("[A-216] un trait bas ailleurs que dans cli_<12 hex> reste refusé", async () => {
    const l = lecteur();
    for (const n of ["donnees/cli_0123/app", "donnees/cli_0123456789AB/app", "donnees/autre_nom/app", "donnees/cli_0123456789ab_x/app"]) {
      await expect(l.lecteur.lire(n), n).rejects.toMatchObject({ code: "requete_refusee" });
    }
    expect(l.urls).toEqual([]);
  });
});
