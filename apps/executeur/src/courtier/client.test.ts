import { describe, expect, it } from "vitest";
import { demanderBaseLecture } from "./client.js";

const T = "11111111-1111-4111-8111-111111111111";
const reponse = (corps: unknown, statut = 200) => (async () => new Response(JSON.stringify(corps), { status: statut })) as unknown as typeof fetch;
const HOTES = ["pgbouncer-donnees.test"];
const ORIGINES = ["https://courtier.test"];
const OK = { type: "base_lecture", hote: "pgbouncer-donnees.test", base: "cli_111111111111", motDePasse: "mot-de-passe-d-essai", expire: "2027-01-10T10:15:00.000Z", valideJusqua: "2027-02-01T00:00:00.000Z" };

describe("client du courtier (exécuteur)", () => {
  it("[C-624] la demande ne porte que tenantId et idTache : ni rôle, ni genre, ni type", async () => {
    let corps = "";
    let url = "";
    const f = (async (u: string, init: RequestInit) => { url = u; corps = String(init.body); return new Response(JSON.stringify(OK)); }) as unknown as typeof fetch;
    await demanderBaseLecture({ url: "https://courtier.test", jeton: "jeton-d-essai", hotes: HOTES, origines: ORIGINES, fetch: f }, T, "tache-1");
    expect(JSON.parse(corps)).toEqual({ tenantId: T, idTache: "tache-1" });
    expect(url).toBe("https://courtier.test/base-lecture");
  });

  it("[C-624] le rôle est déduit de la base reçue (cli_<id>_lecture), jamais lu dans la réponse", async () => {
    const r = await demanderBaseLecture({ url: "https://courtier.test", jeton: "j", hotes: HOTES, origines: ORIGINES, fetch: reponse({ ...OK, role: "cli_111111111111_proprietaire" }) }, T, "tache-1");
    expect(r.role).toBe("cli_111111111111_lecture");
    expect(Object.keys(r)).not.toContain("type");
  });

  it("[A-209] une réponse d'un autre type (base_app) ou avec une base hors forme cli_<12 hex> est refusée", async () => {
    for (const mauvais of [{ ...OK, type: "base_app" }, { ...OK, base: "cli_111111111111_proprietaire" }, { ...OK, base: "../proprietaire" }, { ...OK, motDePasse: "" }]) {
      await expect(demanderBaseLecture({ url: "https://courtier.test", jeton: "j", hotes: HOTES, origines: ORIGINES, fetch: reponse(mauvais) }, T, "tache-1")).rejects.toThrow("reponse_invalide");
    }
    await expect(demanderBaseLecture({ url: "https://courtier.test", jeton: "j", hotes: HOTES, origines: ORIGINES, fetch: reponse({ code: "base_gelee" }, 403) }, T, "tache-1")).rejects.toThrow("remise_refusee");
  });

  it("[A-209] le client refuse un hôte hors liste fermée de la grappe", async () => {
    for (const hote of ["autre.test", "PGBOUNCER-DONNEES.TEST.evil.test", "pgbouncer-donnees.test:5432", "pgbouncer-donnees.test/x", ""]) {
      await expect(demanderBaseLecture({ url: "https://courtier.test", jeton: "j", hotes: HOTES, origines: ORIGINES, fetch: reponse({ ...OK, hote }) }, T, "tache-1"), hote).rejects.toThrow("reponse_invalide");
    }
  });

  it("[A-209] le client refuse un tenantId ou une idTache illisible avant tout envoi", async () => {
    let envois = 0;
    const f = (async () => { envois += 1; return new Response(JSON.stringify(OK)); }) as unknown as typeof fetch;
    for (const [t, i] of [["pas-un-uuid", "tache-1"], [T, ""], [T, "a b"], [T, "../x"], [T, "x".repeat(200)], [T.replace("4111", "4111;"), "tache-1"]] as const) {
      await expect(demanderBaseLecture({ url: "https://courtier.test", jeton: "j", hotes: HOTES, origines: ORIGINES, fetch: f }, t, i)).rejects.toThrow("demande_invalide");
    }
    expect(envois).toBe(0);
  });

  it("[A-209] une liste d'hôtes vide ne laisse rien passer", async () => {
    await expect(demanderBaseLecture({ url: "https://courtier.test", jeton: "j", hotes: [], origines: ORIGINES, fetch: reponse(OK) }, T, "tache-1")).rejects.toThrow("reponse_invalide");
  });

  it("[A-209] le client refuse une URL de courtier hors liste fermée ou hors https, avant tout envoi", async () => {
    let envois = 0;
    const f = (async () => { envois += 1; return new Response(JSON.stringify(OK)); }) as unknown as typeof fetch;
    for (const url of ["http://courtier.test", "https://autre.test", "https://courtier.test.evil.test", "https://courtier.test:8443", "https://u:p@courtier.test", "https://courtier.test/x", "courtier.test", ""]) {
      await expect(demanderBaseLecture({ url, jeton: "j", hotes: HOTES, origines: ORIGINES, fetch: f }, T, "tache-1"), url).rejects.toThrow("url_courtier_refusee");
    }
    await expect(demanderBaseLecture({ url: "https://courtier.test", jeton: "j", hotes: HOTES, origines: [], fetch: f }, T, "tache-1")).rejects.toThrow("url_courtier_refusee");
    expect(envois).toBe(0);
  });
});
