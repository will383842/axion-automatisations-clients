import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Les effets de React sont exécutés tout de suite : la page est appelée comme une fonction.
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useEffect: (f: () => void) => { f(); } }));
vi.stubEnv("NEXT_PUBLIC_ORIGINE_KEYCLOAK", "https://sso.exemple.test");
const { default: Page } = await import("./page.tsx");

const JETON = "TEST-NE-PAS-UTILISER-charge.signature";
const evenements: string[] = [];
let adresse: { hash: string; pathname: string; search: string; assign: (u: string) => void };
let corpsEnvoye: { url: string; init: RequestInit } | undefined;

function monterNavigateur(reponse: () => Promise<unknown>) {
  adresse = { hash: `#j=${JETON}`, pathname: "/entree", search: "", assign: (u) => { evenements.push(`assign:${u}`); } };
  vi.stubGlobal("window", { location: adresse });
  vi.stubGlobal("location", adresse);
  vi.stubGlobal("history", { replaceState: (_e: unknown, _t: string, url: string) => { evenements.push(`replaceState:${url}`); adresse.hash = ""; } });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { evenements.push("fetch"); corpsEnvoye = { url, init }; return { ok: true, json: reponse } as Response; });
}
beforeEach(() => { evenements.length = 0; corpsEnvoye = undefined; });
afterEach(() => vi.unstubAllGlobals());
const attendre = () => new Promise((ok) => setTimeout(ok, 0));

describe("page /entree", () => {
  it("[C-404] la page efface le fragment de l'adresse avant tout envoi", async () => {
    monterNavigateur(async () => ({ url: "https://sso.exemple.test/auth?x=1" }));
    Page();
    await attendre();
    expect(evenements.slice(0, 2)).toEqual(["replaceState:/entree", "fetch"]);
    expect(adresse.hash).toBe("");
  });

  it("[C-404] le jeton part dans le corps, jamais dans l'adresse", async () => {
    monterNavigateur(async () => ({ url: "https://sso.exemple.test/auth?x=1" }));
    Page();
    await attendre();
    expect(corpsEnvoye?.url).toBe("/api/console/v1/entree");
    expect(corpsEnvoye?.init.method).toBe("POST");
    expect(JSON.parse(String(corpsEnvoye?.init.body))).toEqual({ jeton: JETON });
    expect(corpsEnvoye?.url).not.toContain(JETON);
    expect(corpsEnvoye?.init.credentials).toBe("omit");
    expect(evenements.at(-1)).toBe("assign:https://sso.exemple.test/auth?x=1");
  });

  it("[C-404] sans jeton dans le fragment, rien n'est envoyé et la connexion normale s'affiche", async () => {
    monterNavigateur(async () => ({ url: "https://sso.exemple.test/auth" }));
    adresse.hash = "";
    Page();
    await attendre();
    expect(evenements).toEqual(["replaceState:/entree", "assign:/connexion"]);
  });

  it("[C-404] une réponse qui n'est pas une adresse http(s) ou locale est ignorée", async () => {
    for (const mauvaise of ["javascript:alert(1)", "//autre.test/x", "data:text/html,x", 42, null]) {
      evenements.length = 0;
      monterNavigateur(async () => ({ url: mauvaise }));
      Page();
      await attendre();
      expect(evenements.at(-1), String(mauvaise)).toBe("assign:/connexion");
    }
  });

  it("[C-404] une adresse http(s) d'une autre origine que celle de Keycloak est ignorée", async () => {
    for (const autre of ["https://autre.test/auth", "http://sso.exemple.test/auth", "https://sso.exemple.test.autre.test/auth", "https://sso.exemple.test@autre.test/auth"]) {
      evenements.length = 0;
      monterNavigateur(async () => ({ url: autre }));
      Page();
      await attendre();
      expect(evenements.at(-1), autre).toBe("assign:/connexion");
    }
  });

  it("[C-404] la page n'écrit aucun jeton en mémoire durable ni dans le texte affiché", () => {
    const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(source).not.toContain("fonts.googleapis.com");
  });
});
