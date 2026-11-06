import { describe, expect, it } from "vitest";
import { cookieSession, problemesCookie } from "./cookies.ts";

describe("cookies de session", () => {
  it("[C-681] les cookies de session sont Secure, HttpOnly, SameSite, préfixe __Host-, sans Domain", () => {
    expect(cookieSession("abc", 3600)).toBe("__Host-session=abc; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600");
    expect(cookieSession("abc", 3600, { strict: true })).toContain("SameSite=Strict");
    expect(problemesCookie(cookieSession("abc", 3600))).toEqual([]);
    for (const [c, motif] of [
      ["__Host-session=a; Path=/; HttpOnly; SameSite=Lax", "Secure"],
      ["__Host-session=a; Path=/; Secure; SameSite=Lax", "HttpOnly"],
      ["__Host-session=a; Path=/; Secure; HttpOnly", "SameSite"],
      ["__Host-session=a; Path=/; Secure; HttpOnly; SameSite=None", "SameSite"],
      ["session=a; Path=/; Secure; HttpOnly; SameSite=Lax", "__Host-"],
      ["__Host-session=a; Domain=exemple.test; Path=/; Secure; HttpOnly; SameSite=Lax", "Domain"],
      ["__Host-session=a; Path=/app; Secure; HttpOnly; SameSite=Lax", "Path"],
    ] as const) expect(problemesCookie(c).join("|"), c).toContain(motif);
  });

  it("[C-681] une valeur ou une durée hors règle est refusée", () => {
    for (const v of ["", "a;b", "a b", "a,b", "a\r\nSet-Cookie: x=1"]) expect(() => cookieSession(v, 60), v).toThrow();
    for (const s of [0, -1, 1.5, Number.NaN, 31 * 24 * 3600]) expect(() => cookieSession("abc", s), String(s)).toThrow();
    expect(() => cookieSession("abc", 30 * 24 * 3600)).not.toThrow();
  });
});
