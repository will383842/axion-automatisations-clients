import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server.js";
import { problemesCookie } from "../../../packages/securite-web/src/cookies.ts";
import { problemesEntetes } from "../../../packages/securite-web/src/entetes.ts";
import { ECRANS } from "./ecrans.ts";
import { cookieEffacer, cookieSession, cookieTransaction } from "./lib/session.ts";
import { middleware } from "./middleware.ts";

const ORIGINE = "https://console.exemple.test";
const COOKIE = "__Host-session=abc";
const appeler = (chemin: string, init: { methode?: string; origine?: string; cookie?: string | null } = {}) =>
  middleware(new NextRequest(`${ORIGINE}${chemin}`, { method: init.methode ?? "GET", headers: { ...(init.cookie === null ? {} : { cookie: init.cookie ?? COOKIE }), ...(init.origine ? { origin: init.origine } : {}) } }));

describe("sécurité des écrans de la console", () => {
  it("[C-681] toute page de la console renvoie la CSP stricte sans unsafe-inline", () => {
    expect(ECRANS.length).toBeGreaterThan(5);
    const nonces = new Set<string>();
    for (const e of ECRANS) {
      for (const cookie of [COOKIE, null]) {
        const r = appeler(e.route, { cookie });
        expect(problemesEntetes(r.headers), `${e.route} ${cookie ?? "sans session"}`).toEqual([]);
        nonces.add(/'nonce-([^']+)'/.exec(r.headers.get("content-security-policy") ?? "")?.[1] ?? "");
      }
    }
    expect(nonces.has("")).toBe(false);
    expect(nonces.size).toBe(ECRANS.length * 2);
  });

  it("[C-681] la CSP du nonce est aussi transmise à la page (en-tête de requête), et le jeton d'invitation d'une entrée ne fuit pas par Referer", () => {
    const r = appeler("/entree?jeton=jeton-d-essai", { cookie: null });
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    const ok = appeler("/alertes");
    expect(ok.headers.get("x-middleware-request-content-security-policy")).toBe(ok.headers.get("content-security-policy"));
  });

  it("[C-681] @isolation un POST sans origine ou d'une autre origine est refusé avant toute page", async () => {
    for (const origine of [undefined, "https://autre-site.test", "null"]) {
      const r = appeler("/alertes", { methode: "POST", ...(origine ? { origine } : {}) });
      expect(r.status, String(origine)).toBe(403);
      expect(((await r.json()) as { erreur: { code: string } }).erreur.code).toBe("action_interdite");
      expect(problemesEntetes(r.headers)).toEqual([]);
    }
    expect(appeler("/alertes", { methode: "POST", origine: ORIGINE }).status).not.toBe(403);
    expect(appeler("/alertes", { methode: "GET", origine: "https://autre-site.test" }).status).not.toBe(403);
    // L'entrée par lien signé reçoit un POST venu d'ailleurs : sa signature tient lieu de jeton.
    expect(appeler("/api/console/v1/entree", { methode: "POST", origine: "https://autre-site.test", cookie: null }).status).not.toBe(403);
  });

  it("[C-681] les cookies de la console sont Secure, HttpOnly, SameSite, __Host-", () => {
    for (const c of [cookieSession("abc", 3600), cookieTransaction("etat"), cookieEffacer("__Host-session"), cookieEffacer("__Host-transaction")]) expect(problemesCookie(c), c).toEqual([]);
  });

  it("[C-681] un texte contenant du HTML ou du script s'affiche en texte, et aucun HTML brut ni script tiers n'existe dans le code", () => {
    const html = renderToStaticMarkup(createElement("p", null, "<img src=x onerror=alert(1)><script>alert(1)</script>"));
    expect(html).toBe("<p>&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    const racine = fileURLToPath(new URL("../../../", import.meta.url));
    const sources = (d: string): string[] =>
      readdirSync(`${racine}${d}`, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === ".next" ? [] : sources(`${d}/${e.name}`)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [`${d}/${e.name}`] : []));
    for (const f of [...sources("apps/console/src"), ...sources("packages/design/src")]) {
      const texte = readFileSync(`${racine}${f}`, "utf8");
      expect(texte, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|document\.write\(|<script[\s>]|next\/script/);
    }
  });
});
