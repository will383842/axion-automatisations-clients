import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { magasin } from "../../../../lib/session.ts";
import { GET as connexion } from "../../../connexion/route.ts";

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
let reglages: RequestInit[];
function brancherKeycloak(idToken: () => string) {
  echanges = [];
  reglages = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    reglages.push(init ?? {});
    if (url.endsWith("/protocol/openid-connect/certs")) return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    echanges.push(String(init?.body));
    return Response.json({ id_token: idToken(), access_token: "inutile" });
  });
}
function ouvrir(retour = "/clients") {
  const etat = magasin.ouvrirTransaction({ verifier: "V".repeat(43), nonce: "N", retour }) as string;
  return etat;
}
const rappel = (etat: string, cookie: string | null = etat, code = "code-1") =>
  GET(new Request(`https://console.exemple.test/api/auth/rappel?code=${code}&state=${etat}`, { headers: cookie === null ? {} : { cookie: `__Host-transaction=${cookie}` } }));

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); brancherKeycloak(() => jeton()); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("route /api/auth/rappel", () => {
  it("[C-541] un retour valide échange le code avec le vérificateur PKCE puis ouvre la session et renvoie au chemin demandé", async () => {
    const r = await rappel(ouvrir());
    // Page de relais (200) et non redirection 302 : la navigation vers /clients part de la console, le cookie Strict est envoyé.
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain('<meta http-equiv="refresh" content="0;url=/clients">');
    expect(echanges[0]).toContain(`code_verifier=${"V".repeat(43)}`);
    expect(echanges[0]).toContain("grant_type=authorization_code");
    const cookies = r.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(/__Host-session=[\w-]{43,}.*HttpOnly.*Secure.*SameSite=Strict|__Host-session=[\w-]{43,}.*SameSite=Strict.*Secure.*HttpOnly/s);
    expect(cookies).toContain("__Host-transaction=; ");
  });

  it("[LOT3-session] le cookie de session dure 8 h même si le jeton d'identité expire dans 5 minutes", async () => {
    const r = await rappel(ouvrir());
    expect(r.headers.getSetCookie().join("\n")).toContain("Max-Age=28800");
  });

  it("[LOT3-session] la page de relais échappe le chemin de retour (pas d'injection HTML)", async () => {
    const r = await rappel(ouvrir('/a"><b>&c'));
    const corps = await r.text();
    expect(corps).not.toContain("<b>");
    expect(corps).toContain("/a&quot;&gt;&lt;b&gt;&amp;c");
    expect(corps).not.toContain("<script");
  });

  it("[C-541] email absent du jeton : la connexion aboutit (portées du royaume)", async () => {
    brancherKeycloak(() => jeton({ email: undefined }));
    expect((await rappel(ouvrir())).status).toBe(200);
  });

  it("[C-541] lien signé valide sans double facteur Keycloak -> refus (puis aucune session)", async () => {
    // Forme rendue par C6 : /connexion?login_hint=<e-mail> ; Keycloak renvoie ensuite un jeton sans second facteur.
    const depart = connexion(new Request("https://console.exemple.test/connexion?login_hint=equipe%40exemple.fr"));
    const etat = new URL(depart.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect(etat).not.toBe("");
    for (const faible of [{ acr: "1", amr: ["pwd"] }, { amr: ["pwd"] }, { amr: undefined }, { acr: undefined }]) {
      brancherKeycloak(() => jeton(faible));
      const e = new URL(connexion(new Request("https://console.exemple.test/connexion?login_hint=equipe%40exemple.fr")).headers.get("location") ?? "").searchParams.get("state") ?? "";
      const r = await GET(new Request(`https://console.exemple.test/api/auth/rappel?code=c&state=${e}`, { headers: { cookie: `__Host-transaction=${e}` } }));
      expect(r.status, JSON.stringify(faible)).toBe(403);
      expect(r.headers.getSetCookie().join("")).not.toContain("__Host-session=");
    }
  });

  it("[C-541] les clés du royaume sont lues sans suivre de redirection et une réponse en erreur refuse la connexion", async () => {
    await rappel(ouvrir());
    expect(reglages.every((x) => x.redirect === "error")).toBe(true);
    vi.stubGlobal("fetch", async (url: string) => (url.endsWith("/certs") ? new Response("{}", { status: 500 }) : Response.json({ id_token: jeton() })));
    expect((await rappel(ouvrir())).status).toBe(403);
  });

  it("[C-541] un state absent, rejoué ou d'un autre navigateur est refusé sans session", async () => {
    const etat = ouvrir();
    for (const r of [await rappel("inconnu", "inconnu"), await rappel(etat, null), await rappel(etat, "autre")]) {
      expect(r.status).toBe(403);
      expect(r.headers.getSetCookie().join("")).not.toContain("__Host-session=");
    }
    expect(echanges).toHaveLength(0);
    const bon = ouvrir();
    expect((await rappel(bon)).status).toBe(200);
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

  it("[LOT3-session] sans session, la fin de session Keycloak reçoit quand même client_id", async () => {
    const r = await POST(new Request("https://console.exemple.test/api/auth/deconnexion", { method: "POST", headers: { origin: "https://console.exemple.test" } }));
    const u = new URL(r.headers.get("location") ?? "");
    expect(u.searchParams.get("client_id")).toBe("console");
    expect(u.searchParams.has("id_token_hint")).toBe(false);
    expect(u.searchParams.get("post_logout_redirect_uri")).toBe("https://console.exemple.test/");
  });

  it("[LOT3-session] une déconnexion demandée depuis une autre origine est refusée et la session reste intacte", async () => {
    const id = await connecte();
    const r = await POST(new Request("https://console.exemple.test/api/auth/deconnexion", { method: "POST", headers: { cookie: `__Host-session=${id}`, origin: "https://autre.test" } }));
    expect(r.status).toBe(403);
    expect(magasin.lireSession(id)).toBeDefined();
  });
});
