import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server.js";
import { problemesCookie } from "../../../packages/securite-web/src/cookies.ts";
import { problemesEntetes } from "../../../packages/securite-web/src/entetes.ts";
import { ECRANS } from "./ecrans.ts";
import { cookieEffacer, cookieSession, cookieTransaction } from "./lib/session.ts";
import { middleware } from "./middleware.ts";

const ORIGINE = "https://console.exemple.test";
// Adresse interne de la sortie autonome de Next : nextUrl.origin vaut toujours celle-là, jamais l'adresse publique (E1).
const INTERNE = "http://localhost:3000";
const ancienneOrigine = process.env["CONSOLE_ORIGINE"];
beforeAll(() => { process.env["CONSOLE_ORIGINE"] = ORIGINE; });
afterAll(() => { if (ancienneOrigine === undefined) delete process.env["CONSOLE_ORIGINE"]; else process.env["CONSOLE_ORIGINE"] = ancienneOrigine; });
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
  it("[C-681] le middleware compare l'origine à CONSOLE_ORIGINE et non à l'adresse interne de Next", () => {
    const interne = (origine: string) =>
      middleware(new NextRequest(`${INTERNE}/alertes`, { method: "POST", headers: { cookie: COOKIE, origin: origine } }));
    expect(interne(ORIGINE).status).not.toBe(403);
    expect(interne(INTERNE).status).toBe(403);
    expect(interne("https://autre-site.test").status).toBe(403);
    // Configuration absente ou invalide : refus.
    for (const valeur of [undefined, "", "pas-une-adresse", "http://console.exemple.test"]) {
      if (valeur === undefined) delete process.env["CONSOLE_ORIGINE"]; else process.env["CONSOLE_ORIGINE"] = valeur;
      try {
        expect(interne(ORIGINE).status, String(valeur)).toBe(403);
      } finally {
        process.env["CONSOLE_ORIGINE"] = ORIGINE;
      }
    }
  });

  it("[C-681] le formulaire de déconnexion de la console passe le contrôle d'origine", () => {
    const source = readFileSync(fileURLToPath(new URL("./app/(equipe)/layout.tsx", import.meta.url)), "utf8");
    const formulaire = /<form action="([^"]+)" method="post">/.exec(source);
    expect(formulaire, "formulaire de déconnexion introuvable").not.toBeNull();
    // Un vrai navigateur envoie l'origine publique ; Next voit l'adresse interne.
    const r = middleware(new NextRequest(`${INTERNE}${formulaire![1]}`, { method: "POST", headers: { cookie: COOKIE, origin: ORIGINE } }));
    expect(r.status).not.toBe(403);
  });

  it("[C-681] chaque balise script de chaque page servie porte le nonce de sa CSP", { timeout: 420_000 }, () => {
    const racine = fileURLToPath(new URL("../", import.meta.url));
    execFileSync("pnpm", ["exec", "next", "build"], { cwd: racine, stdio: "pipe", timeout: 400_000, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" } });
    const html = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? html(`${d}/${e.name}`) : e.name.endsWith(".html") ? [`${d}/${e.name}`] : []));
    // Une page prérendue au build est figée : aucun nonce ne peut y être posé par réponse. Toute page servie doit donc être dynamique.
    const figees = html(`${racine}.next/server/app`);
    for (const f of figees) {
      for (const balise of readFileSync(f, "utf8").match(/<script\b[^>]*>/g) ?? []) expect(balise, f).toMatch(/\snonce="[^"]+"/);
    }
    expect(figees, "pages prérendues sans nonce").toEqual([]);
  });
});
