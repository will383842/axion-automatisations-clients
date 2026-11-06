import { describe, expect, it } from "vitest";
import { creerJetonCsrf, verifierGeste, verifierJetonCsrf } from "./csrf.ts";

const SECRET = "secret-d-essai-genere-pour-les-tests-0001";
const ORIGINE = "https://console.exemple.test";

describe("CSRF", () => {
  it("[C-681] @isolation un POST sans jeton CSRF ou depuis une autre origine est refusé", async () => {
    const jeton = await creerJetonCsrf(SECRET, "session-1");
    const base = { methode: "POST", origine: ORIGINE, origineAttendue: ORIGINE, jeton, sessionId: "session-1", secret: SECRET };
    expect(await verifierGeste(base)).toBe("ok");
    expect(await verifierGeste({ ...base, jeton: null })).toBe("jeton");
    expect(await verifierGeste({ ...base, jeton: "" })).toBe("jeton");
    expect(await verifierGeste({ ...base, jeton: `${jeton}x` })).toBe("jeton");
    expect(await verifierGeste({ ...base, sessionId: "session-2" })).toBe("jeton");
    expect(await verifierGeste({ ...base, secret: `${SECRET}-autre` })).toBe("jeton");
    for (const origine of ["https://autre-site.test", "http://console.exemple.test", "https://console.exemple.test.autre.test", "null", "", null]) {
      expect(await verifierGeste({ ...base, origine }), String(origine)).toBe("origine");
    }
    for (const methode of ["PUT", "PATCH", "DELETE", "post", "INCONNUE"]) expect(await verifierGeste({ ...base, methode, jeton: null }), methode).toBe("jeton");
  });

  it("[C-681] une requête GET ne change rien : ni jeton ni origine exigés", async () => {
    for (const methode of ["GET", "HEAD", "OPTIONS"]) expect(await verifierGeste({ methode, origine: null, origineAttendue: ORIGINE, jeton: null, sessionId: "s", secret: SECRET })).toBe("ok");
  });

  it("[C-681] le jeton est lié à la session et ne se devine pas", async () => {
    const a = await creerJetonCsrf(SECRET, "session-1");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await creerJetonCsrf(SECRET, "session-1")).toBe(a);
    expect(await creerJetonCsrf(SECRET, "session-2")).not.toBe(a);
    expect(await verifierJetonCsrf(SECRET, "session-1", a)).toBe(true);
    expect(await verifierJetonCsrf(SECRET, "session-1", a.toUpperCase())).toBe(false);
    await expect(creerJetonCsrf("court", "s")).rejects.toThrow();
    await expect(creerJetonCsrf(SECRET, "")).rejects.toThrow();
  });
});
