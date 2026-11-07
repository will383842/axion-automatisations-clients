import { describe, expect, it } from "vitest";
import { testerConnexion } from "./tester.js";

const reponse = (statut: number) => (async () => new Response("{}", { status: statut })) as typeof fetch;

describe("test immédiat", () => {
  it("[A-385] chaque refus du test donne un code fermé : 401, 403, panne, délai ; une lecture sans effet réussit", async () => {
    const jeton = "marqueur-jeton-test-4e21";
    expect(await testerConnexion({ fetch: reponse(200) }, "microsoft", jeton)).toEqual({ ok: true });
    expect(await testerConnexion({ fetch: reponse(401) }, "google", jeton)).toEqual({ ok: false, code: "refuse_401" });
    expect(await testerConnexion({ fetch: reponse(403) }, "microsoft", jeton)).toEqual({ ok: false, code: "refuse_403" });
    expect(await testerConnexion({ fetch: reponse(503) }, "microsoft", jeton)).toEqual({ ok: false, code: "indisponible" });
    const coince = (async () => new Promise<Response>(() => undefined)) as typeof fetch;
    const lent = await testerConnexion({ fetch: coince, delaiMs: 20 }, "google", jeton);
    expect(lent).toEqual({ ok: false, code: "delai" });
    expect(JSON.stringify(lent)).not.toContain(jeton);
  });
});
