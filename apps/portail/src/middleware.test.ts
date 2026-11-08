import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server.js";
import { problemesEntetes } from "../../../packages/securite-web/src/entetes.ts";
import { middleware } from "./middleware.ts";

const ORIGINE = "https://portail.exemple.test";
const ancienne = process.env["PORTAIL_ORIGINE"];
beforeAll(() => { process.env["PORTAIL_ORIGINE"] = ORIGINE; });
afterAll(() => { if (ancienne === undefined) delete process.env["PORTAIL_ORIGINE"]; else process.env["PORTAIL_ORIGINE"] = ancienne; });
const COOKIE = "__Host-session=abc";
const appeler = (chemin: string, init: { methode?: string; origine?: string; cookie?: string | null } = {}) =>
  middleware(new NextRequest(`${ORIGINE}${chemin}`, { method: init.methode ?? "GET", headers: { ...(init.cookie === null ? {} : { cookie: init.cookie ?? COOKIE }), ...(init.origine ? { origin: init.origine } : {}) } }));

describe("sécurité des écrans du portail", () => {
  it("[C-681] toute page du portail renvoie la CSP stricte sans unsafe-inline", async () => {
    const pages = ["/", "/automatisations", "/factures", "/mon-compte", "/api/auth/connexion", "/api/sante"];
    const nonces = new Set<string>();
    for (const p of pages) {
      for (const cookie of [COOKIE, null]) {
        const r = appeler(p, { cookie });
        expect(problemesEntetes(r.headers), `${p} ${cookie ?? "sans session"}`).toEqual([]);
        const csp = r.headers.get("content-security-policy") ?? "";
        expect(csp).not.toContain("unsafe-inline");
        nonces.add(/'nonce-([^']+)'/.exec(csp)?.[1] ?? "");
      }
    }
    expect(nonces.has("")).toBe(false);
    expect(nonces.size).toBe(pages.length * 2);
    const refus = appeler("/factures", { methode: "POST" });
    expect(refus.status).toBe(403);
    expect(problemesEntetes(refus.headers)).toEqual([]);
    const ok = appeler("/factures");
    expect(ok.headers.get("x-middleware-request-content-security-policy")).toBe(ok.headers.get("content-security-policy"));
  });

  it("[LOT6-connexion] geste POST d'une autre origine (ou origine absente, ou PORTAIL_ORIGINE invalide) : 403", () => {
    for (const origine of [undefined, "https://autre-site.test", "null"]) expect(appeler("/factures", { methode: "POST", ...(origine ? { origine } : {}) }).status, String(origine)).toBe(403);
    expect(appeler("/factures", { methode: "POST", origine: ORIGINE }).status).not.toBe(403);
    process.env["PORTAIL_ORIGINE"] = "http://interne";
    try { expect(appeler("/factures", { methode: "POST", origine: "http://interne" }).status).toBe(403); } finally { process.env["PORTAIL_ORIGINE"] = ORIGINE; }
  });

  it("[LOT6-connexion] sans cookie : redirection vers /api/auth/connexion avec retour = chemin local", () => {
    const r = appeler("/factures?page=2", { cookie: null });
    expect(r.headers.get("location")).toBe(`${ORIGINE}/api/auth/connexion?retour=%2Ffactures%3Fpage%3D2`);
    expect(appeler("/api/auth/rappel", { cookie: null }).headers.get("location")).toBeNull();
    expect(appeler("/api/sante", { cookie: null }).headers.get("location")).toBeNull();
    expect(appeler("/factures").headers.get("location")).toBeNull();
  });
});
