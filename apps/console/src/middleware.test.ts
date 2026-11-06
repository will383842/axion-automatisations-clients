import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server.js";
import { middleware } from "./middleware.ts";

const appeler = (chemin: string, cookie?: string) =>
  middleware(new NextRequest(`https://console.exemple.test${chemin}`, { headers: cookie ? { cookie } : {} }));

describe("middleware de la console", () => {
  it("[C-541] sans cookie de session, une page de l'équipe renvoie vers la reconnexion avec le chemin demandé", () => {
    const r = appeler("/clients?page=2");
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("https://console.exemple.test/connexion/reconnexion?retour=%2Fclients%3Fpage%3D2");
  });

  it("[C-541] la connexion, l'entrée par lien signé, le rappel et la santé restent publics", () => {
    for (const c of ["/connexion", "/connexion/reconnexion", "/entree", "/api/auth/rappel", "/api/sante"]) {
      expect(appeler(c).headers.get("location"), c).toBeNull();
    }
  });

  it("[C-541] un cookie présent laisse passer : le contenu de la session est revérifié côté serveur, pas ici", () => {
    expect(appeler("/clients", "__Host-session=abc").headers.get("location")).toBeNull();
  });

  it("[LOT3-session] un en-tête de chemin envoyé par le navigateur est écrasé", () => {
    const r = middleware(new NextRequest("https://console.exemple.test/alertes", { headers: { cookie: "__Host-session=abc", "x-chemin": "/forge" } }));
    expect(r.headers.get("x-middleware-request-x-chemin")).toBe("/alertes");
  });
});
