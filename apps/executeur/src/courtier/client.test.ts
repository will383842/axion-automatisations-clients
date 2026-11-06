import { describe, expect, it } from "vitest";
import { demanderBaseLecture } from "./client.js";

const T = "11111111-1111-4111-8111-111111111111";
const reponse = (corps: unknown, statut = 200) => (async () => new Response(JSON.stringify(corps), { status: statut })) as unknown as typeof fetch;
const OK = { type: "base_lecture", hote: "pgbouncer-donnees.test", base: "cli_111111111111", motDePasse: "mot-de-passe-d-essai", expire: "2027-01-10T10:15:00.000Z", valideJusqua: "2027-02-01T00:00:00.000Z" };

describe("client du courtier (exécuteur)", () => {
  it("[C-624] la demande ne porte que tenantId et idTache : ni rôle, ni genre, ni type", async () => {
    let corps = "";
    let url = "";
    const f = (async (u: string, init: RequestInit) => { url = u; corps = String(init.body); return new Response(JSON.stringify(OK)); }) as unknown as typeof fetch;
    await demanderBaseLecture({ url: "http://courtier.test", jeton: "jeton-d-essai", fetch: f }, T, "tache-1");
    expect(JSON.parse(corps)).toEqual({ tenantId: T, idTache: "tache-1" });
    expect(url).toBe("http://courtier.test/base-lecture");
  });

  it("[C-624] le rôle est déduit de la base reçue (cli_<id>_lecture), jamais lu dans la réponse", async () => {
    const r = await demanderBaseLecture({ url: "http://courtier.test", jeton: "j", fetch: reponse({ ...OK, role: "cli_111111111111_proprietaire" }) }, T, "tache-1");
    expect(r.role).toBe("cli_111111111111_lecture");
    expect(Object.keys(r)).not.toContain("type");
  });

  it("[A-209] une réponse d'un autre type (base_app) ou avec une base hors forme cli_<12 hex> est refusée", async () => {
    for (const mauvais of [{ ...OK, type: "base_app" }, { ...OK, base: "cli_111111111111_proprietaire" }, { ...OK, base: "../proprietaire" }, { ...OK, motDePasse: "" }]) {
      await expect(demanderBaseLecture({ url: "http://courtier.test", jeton: "j", fetch: reponse(mauvais) }, T, "tache-1")).rejects.toThrow("reponse_invalide");
    }
    await expect(demanderBaseLecture({ url: "http://courtier.test", jeton: "j", fetch: reponse({ code: "base_gelee" }, 403) }, T, "tache-1")).rejects.toThrow("remise_refusee");
  });
});
