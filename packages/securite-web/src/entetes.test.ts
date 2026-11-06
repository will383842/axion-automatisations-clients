import { describe, expect, it } from "vitest";
import { construireCsp, genererNonce } from "./csp.ts";
import { appliquerEntetes, entetesSecurite, problemesEntetes } from "./entetes.ts";

describe("CSP stricte", () => {
  it("[C-681] la CSP n'a ni unsafe-inline ni unsafe-eval, ni joker, et ferme cadres, formulaires et objets", () => {
    const csp = construireCsp({ nonce: "AbC123+/=" });
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:|data:/);
    expect(csp).toContain("script-src 'nonce-AbC123+/=' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  it("[C-681] un nonce est neuf à chaque appel et un nonce qui sortirait de l'en-tête est refusé", () => {
    expect(genererNonce()).not.toBe(genererNonce());
    expect(genererNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    for (const mauvais of ["", "a b", "a;b", "a'b", "a\r\nX: 1", "a,b"]) expect(() => construireCsp({ nonce: mauvais }), mauvais).toThrow();
  });
});

describe("en-têtes de sécurité", () => {
  it("[C-681] toute réponse porte les six en-têtes, dont Referrer-Policy no-referrer (le jeton d'invitation ne fuit pas par Referer)", () => {
    const h = new Headers();
    appliquerEntetes(h, "AbC123+/=");
    expect(problemesEntetes(h)).toEqual([]);
    expect(h.get("referrer-policy")).toBe("no-referrer");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(h.get("strict-transport-security")).toMatch(/^max-age=\d{8,}; includeSubDomains$/);
    expect(h.get("permissions-policy")).toMatch(/camera=\(\)/);
    expect(h.get("permissions-policy")).not.toContain("*");
    expect(Object.keys(entetesSecurite("AbC123+/=")).sort()).toHaveLength(6);
  });

  it("[C-681] une nouvelle route sans les en-têtes fait échouer la garde de CI", () => {
    const h = new Headers({ "x-content-type-options": "nosniff" });
    expect(problemesEntetes(h).length).toBeGreaterThanOrEqual(5);
    const faible = new Headers();
    appliquerEntetes(faible, "AbC123+/=");
    faible.set("content-security-policy", "script-src 'unsafe-inline'");
    expect(problemesEntetes(faible)).toContain("content-security-policy : unsafe-inline ou unsafe-eval interdit");
    faible.set("content-security-policy", "default-src 'self'");
    expect(problemesEntetes(faible).join("|")).toContain("nonce");
    faible.set("referrer-policy", "origin");
    expect(problemesEntetes(faible)).toContain("referrer-policy : no-referrer exigé");
  });
});
