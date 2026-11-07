import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { magasin } from "../../../../auth/session.ts";
import { GET as connexion } from "./route.ts";
import { GET as rappel } from "../rappel/route.ts";
import { POST as deconnexion } from "../deconnexion/route.ts";

const ENV = {
  PORTAIL_CONNEXION_OUVERTE: "1",
  PORTAIL_EMETTEUR_OIDC: "https://sso.exemple.test/realms/clients",
  PORTAIL_CLIENT_OIDC: "portail",
  PORTAIL_SECRET_OIDC: "secret-de-test-seulement",
  PORTAIL_ORIGINE: "https://portail.exemple.test",
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jeton(charge: object = {}) {
  const t = Math.floor(Date.now() / 1000);
  const e = b64({ alg: "RS256", kid: "k1" });
  const c = b64({ iss: ENV.PORTAIL_EMETTEUR_OIDC, aud: "portail", azp: "portail", sub: "u1", nonce: "N", iat: t, exp: t + 300, roles_portail: ["comptable"], organisations: ["/organisations/3f2b8c1e-9a4d-4b6e-8c5f-1a2b3c4d5e6f"], ...charge });
  return `${e}.${c}.${sign("sha256", Buffer.from(`${e}.${c}`), privateKey).toString("base64url")}`;
}
let appels: Array<{ url: string; corps: string }>;
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  appels = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/certs")) return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    appels.push({ url, corps: String(init?.body ?? "") });
    return Response.json({ id_token: jeton(), access_token: "acces-de-test", refresh_token: "rafraichissement-de-test", expires_in: 300 });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const ouvrir = (retour = "/factures") => magasin.ouvrirTransaction({ verifier: "V".repeat(43), nonce: "N", retour }) as string;
const appelRappel = (etat: string, cookie: string | null = etat, suite = "code=c1") => rappel(new Request(`https://portail.exemple.test/api/auth/rappel?${suite}&state=${etat}`, { headers: cookie === null ? {} : { cookie: `__Host-transaction=${cookie}` } }));

describe("routes de connexion du portail", () => {
  it("[LOT6-connexion] interrupteur PORTAIL_CONNEXION_OUVERTE absent : 404 sur connexion, rappel et déconnexion", async () => {
    vi.stubEnv("PORTAIL_CONNEXION_OUVERTE", "");
    expect(connexion(new Request("https://portail.exemple.test/api/auth/connexion")).status).toBe(404);
    expect((await appelRappel("x")).status).toBe(404);
    expect(deconnexion(new Request("https://portail.exemple.test/api/auth/deconnexion", { method: "POST", headers: { origin: ENV.PORTAIL_ORIGINE } })).status).toBe(404);
  });

  it("[LOT6-connexion] connexion puis rappel : 302 direct vers le retour local, cookie Lax, code échangé avec le vérificateur PKCE", async () => {
    const c = connexion(new Request("https://portail.exemple.test/api/auth/connexion?retour=/factures"));
    expect(c.status).toBe(302);
    const etat = new URL(c.headers.get("location") as string).searchParams.get("state") as string;
    expect(c.headers.getSetCookie().join("\n")).toContain(`__Host-transaction=${etat}`);
    const r = await appelRappel(etat);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/factures");
    expect(appels[0]?.corps).toContain("grant_type=authorization_code");
    expect(appels[0]?.corps).toMatch(/code_verifier=[\w-]{43}/);
    expect(r.headers.getSetCookie().join("\n")).toMatch(/__Host-session=[\w-]{43,}.*SameSite=Lax/);
  });

  it("[LOT6-connexion] rappel : state absent du cookie, error, code absent : 403 et cookie de transaction effacé", async () => {
    for (const r of [await appelRappel(ouvrir(), null), await appelRappel(ouvrir(), "autre"), await appelRappel(ouvrir(), undefined, "error=access_denied"), await appelRappel(ouvrir(), undefined, "x=1")]) {
      expect(r.status).toBe(403);
      expect(r.headers.getSetCookie().join("\n")).toContain("__Host-transaction=; ");
    }
    expect(appels).toEqual([]);
  });

  it("[LOT6-connexion] déconnexion : POST seul, Origin exigé, refresh_token envoyé au point logout de Keycloak, session détruite, cookie effacé, 303 vers la fin de session", async () => {
    const s = magasin.ouvrirSession({ sub: "u1", role: "comptable", organisation: "o", jetonIdentite: "id-de-test", jetonAcces: "a", jetonRafraichissement: "r-de-test", accesExpireA: Date.now() + 300_000 });
    const requete = (origine?: string) => new Request("https://portail.exemple.test/api/auth/deconnexion", { method: "POST", headers: { cookie: `__Host-session=${s.id}`, ...(origine ? { origin: origine } : {}) } });
    expect(deconnexion(requete()).status).toBe(403);
    expect(deconnexion(requete("https://autre.test")).status).toBe(403);
    expect(magasin.lireSession(s.id)).toBeDefined();
    const r = await deconnexion(requete(ENV.PORTAIL_ORIGINE));
    expect(r.status).toBe(303);
    expect(appels[0]?.url).toBe("https://sso.exemple.test/realms/clients/protocol/openid-connect/logout");
    expect(appels[0]?.corps).toContain("refresh_token=r-de-test");
    expect(appels[0]?.corps).toContain("client_id=portail");
    expect(magasin.lireSession(s.id)).toBeUndefined();
    expect(r.headers.get("location")).toContain("id_token_hint=id-de-test");
    expect(r.headers.get("location")).toContain("post_logout_redirect_uri=https%3A%2F%2Fportail.exemple.test%2F");
    expect(r.headers.getSetCookie().join("\n")).toContain("__Host-session=; ");
  });
});
