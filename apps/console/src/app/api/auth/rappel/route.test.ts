import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { magasin } from "../../../../lib/session.ts";

const ENV = {
  CONSOLE_CONNEXION_OUVERTE: "1",
  CONSOLE_EMETTEUR_OIDC: "https://sso.exemple.test/realms/equipe",
  CONSOLE_CLIENT_OIDC: "console",
  CONSOLE_SECRET_OIDC: "secret-de-test-seulement",
  CONSOLE_ORIGINE: "https://console.exemple.test",
};
const { GET } = await import("./route.ts");
const { POST } = await import("../deconnexion/route.ts");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jeton(charge: object = {}) {
  const t = Math.floor(Date.now() / 1000);
  const e = b64({ alg: "RS256", kid: "k1" });
  const c = b64({ iss: ENV.CONSOLE_EMETTEUR_OIDC, aud: "console", azp: "console", sub: "u1", email: "a@exemple.fr", nonce: "N", acr: "mfa", amr: ["pwd", "otp"], auth_time: t, iat: t, exp: t + 300, ...charge });
  return `${e}.${c}.${sign("sha256", Buffer.from(`${e}.${c}`), privateKey).toString("base64url")}`;
}
let echanges: string[];
function brancherKeycloak(idToken: () => string) {
  echanges = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/protocol/openid-connect/certs")) return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    echanges.push(String(init?.body));
    return Response.json({ id_token: idToken(), access_token: "inutile" });
  });
}
function ouvrir(retour = "/clients") {
  const etat = magasin.ouvrirTransaction({ verifier: "V".repeat(43), nonce: "N", retour });
  return etat;
}
const rappel = (etat: string, cookie: string | null = etat, code = "code-1") =>
  GET(new Request(`https://console.exemple.test/api/auth/rappel?code=${code}&state=${etat}`, { headers: cookie === null ? {} : { cookie: `__Host-transaction=${cookie}` } }));

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); brancherKeycloak(() => jeton()); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("route /api/auth/rappel", () => {
  it("[C-541] un retour valide échange le code avec le vérificateur PKCE puis ouvre la session et renvoie au chemin demandé", async () => {
    const r = await rappel(ouvrir());
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/clients");
    expect(echanges[0]).toContain(`code_verifier=${"V".repeat(43)}`);
    expect(echanges[0]).toContain("grant_type=authorization_code");
    const cookies = r.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(/__Host-session=[\w-]{43,}.*HttpOnly.*Secure.*SameSite=Strict|__Host-session=[\w-]{43,}.*SameSite=Strict.*Secure.*HttpOnly/s);
    expect(cookies).toContain("__Host-transaction=; ");
  });

  it("[C-541] un state absent, rejoué ou d'un autre navigateur est refusé sans session", async () => {
    const etat = ouvrir();
    for (const r of [await rappel("inconnu", "inconnu"), await rappel(etat, null), await rappel(etat, "autre")]) {
      expect(r.status).toBe(403);
      expect(r.headers.getSetCookie().join("")).not.toContain("__Host-session=");
    }
    expect(echanges).toHaveLength(0);
    const bon = ouvrir();
    expect((await rappel(bon)).status).toBe(302);
    expect((await rappel(bon)).status).toBe(403);
  });

  it("[C-541] un jeton sans double facteur (acr) est refusé et aucune session n'est ouverte", async () => {
    brancherKeycloak(() => jeton({ acr: "1", amr: ["pwd"] }));
    const r = await rappel(ouvrir());
    expect(r.status).toBe(403);
    expect(r.headers.getSetCookie().join("")).not.toContain("__Host-session=");
  });

  it("[C-541] un nonce rejoué ou un jeton d'un autre royaume est refusé", async () => {
    brancherKeycloak(() => jeton({ nonce: "ancien" }));
    expect((await rappel(ouvrir())).status).toBe(403);
    brancherKeycloak(() => jeton({ iss: "https://sso.exemple.test/realms/clients" }));
    expect((await rappel(ouvrir())).status).toBe(403);
  });

  it("[C-541] un refus de Keycloak ou un échange en erreur ne laisse aucune session", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 400 }));
    expect((await rappel(ouvrir())).status).toBe(403);
    const e = ouvrir();
    expect((await GET(new Request(`https://console.exemple.test/api/auth/rappel?error=access_denied&state=${e}`, { headers: { cookie: `__Host-transaction=${e}` } }))).status).toBe(403);
  });
});

describe("route /api/auth/deconnexion", () => {
  async function connecte() {
    const r = await rappel(ouvrir());
    return /__Host-session=([\w-]+)/.exec(r.headers.getSetCookie().join("\n"))?.[1] ?? "";
  }

  it("[LOT3-session] la déconnexion détruit la session côté serveur et renvoie vers la fin de session Keycloak", async () => {
    const id = await connecte();
    expect(magasin.lireSession(id)).toBeDefined();
    const r = await POST(new Request("https://console.exemple.test/api/auth/deconnexion", { method: "POST", headers: { cookie: `__Host-session=${id}`, origin: "https://console.exemple.test" } }));
    expect(r.status).toBe(303);
    expect(magasin.lireSession(id)).toBeUndefined();
    const u = new URL(r.headers.get("location") ?? "");
    expect(u.origin + u.pathname).toBe("https://sso.exemple.test/realms/equipe/protocol/openid-connect/logout");
    expect(u.searchParams.get("id_token_hint")).toBeTruthy();
    expect(r.headers.getSetCookie().join("")).toContain("__Host-session=; ");
  });

  it("[LOT3-session] une déconnexion demandée depuis une autre origine est refusée et la session reste intacte", async () => {
    const id = await connecte();
    const r = await POST(new Request("https://console.exemple.test/api/auth/deconnexion", { method: "POST", headers: { cookie: `__Host-session=${id}`, origin: "https://autre.test" } }));
    expect(r.status).toBe(403);
    expect(magasin.lireSession(id)).toBeDefined();
  });
});
