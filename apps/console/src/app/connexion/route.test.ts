import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { magasin } from "../../lib/session.ts";
import config from "../../../next.config.ts";

const ENV = {
  CONSOLE_CONNEXION_OUVERTE: "1",
  CONSOLE_EMETTEUR_OIDC: "https://sso.exemple.test/realms/equipe",
  CONSOLE_CLIENT_OIDC: "console",
  CONSOLE_SECRET_OIDC: "secret-de-test-seulement",
  CONSOLE_ORIGINE: "https://console.exemple.test",
};
const { GET } = await import("./route.ts");
const appeler = (requete: string) => GET(new Request(`https://console.exemple.test${requete}`));
const place = (r: Response) => new URL(r.headers.get("location") ?? "http://rien.invalid");

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("route /connexion", () => {
  it("[C-541] la route est fermée par défaut (interrupteur)", async () => {
    vi.stubEnv("CONSOLE_CONNEXION_OUVERTE", "");
    expect((await appeler("/connexion")).status).toBe(404);
  });

  it("[C-541] la route construit elle-même l'adresse Keycloak : PKCE S256, state, nonce, prompt=login, acr mfa", async () => {
    const r = await appeler("/connexion?login_hint=equipe%40exemple.fr&retour=%2Fclients");
    expect(r.status).toBe(302);
    const u = place(r);
    expect(u.origin).toBe("https://sso.exemple.test");
    for (const p of ["code_challenge", "state", "nonce"]) expect(u.searchParams.get(p)?.length).toBeGreaterThanOrEqual(22);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("prompt")).toBe("login");
    expect(u.searchParams.get("acr_values")).toBe("mfa");
    expect(u.searchParams.get("login_hint")).toBe("equipe@exemple.fr");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__Host-transaction=${u.searchParams.get("state")}`);
    expect(cookie).toContain("HttpOnly");
  });

  it("[C-404] un login_hint de forme invalide est refusé et rien n'est envoyé à Keycloak", async () => {
    for (const mauvais of ["x", "a%40exemple.fr%26prompt%3Dnone", `${"a".repeat(300)}%40exemple.fr`, "a%40exemple.fr%0d%0aX%3A1"]) {
      const r = await appeler(`/connexion?login_hint=${mauvais}`);
      expect(r.status, mauvais).toBe(400);
      expect(r.headers.get("location")).toBeNull();
    }
    expect((await appeler("/connexion?login_hint=a%40exemple.fr&login_hint=b%40exemple.fr")).status).toBe(400);
  });

  it("[C-404] aucun autre paramètre de l'adresse locale n'est copié vers Keycloak", async () => {
    const r = await appeler("/connexion?login_hint=a%40exemple.fr&prompt=none&acr_values=0&redirect_uri=https%3A%2F%2Fautre.test&max_age=999&client_id=x&scope=admin");
    const u = place(r);
    expect(u.searchParams.get("prompt")).toBe("login");
    expect(u.searchParams.get("acr_values")).toBe("mfa");
    expect(u.searchParams.get("max_age")).toBe("0");
    expect(u.searchParams.get("client_id")).toBe("console");
    expect(u.searchParams.get("scope")).toBe("openid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://console.exemple.test/api/auth/rappel");
  });

  it("[C-404] login_hint n'est écrit dans aucun journal de la console", async () => {
    const sorties = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(process.stdout, "write")];
    await appeler("/connexion?login_hint=secret.unique%40exemple.fr");
    await appeler("/connexion?login_hint=mauvais");
    for (const s of sorties) expect(JSON.stringify(s.mock.calls)).not.toContain("secret.unique");
  });

  it("[LOT3-session] au plafond des transactions ouvertes, la route répond 503 sans créer d'entrée, puis reprend", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 10_000; i++) magasin.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" });
      const r = await appeler("/connexion");
      expect(r.status).toBe(503);
      expect(r.headers.get("location")).toBeNull();
      expect(r.headers.get("set-cookie")).toBeNull();
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await appeler("/connexion")).status).toBe(302);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[C-404] la réponse porte Referrer-Policy: no-referrer et n'est pas mise en cache", async () => {
    for (const r of [await appeler("/connexion?login_hint=a%40exemple.fr"), await appeler("/connexion?login_hint=x")]) {
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    const regles = (await config.headers?.()) ?? [];
    expect(regles.flatMap((x) => x.headers).find((h) => h.key === "Referrer-Policy")?.value).toBe("no-referrer");
  });
});
