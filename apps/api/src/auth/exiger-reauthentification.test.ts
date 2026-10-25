import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { exigerJeton } from "./oidc.ts";
import { creerVerificateur } from "./oidc.ts";
import { exigerReauthentification } from "./exiger-reauthentification.ts";

const EMETTEUR = "https://sso.socle.test/realms/equipe";
const AUDIENCE = "api-equipe";
const MAINTENANT = Math.floor(Date.now() / 1000);

let cle: CryptoKey;
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  const k = await generateKeyPair("RS256");
  cle = k.privateKey;
  const verificateur = creerVerificateur({
    emetteur: EMETTEUR,
    audience: AUDIENCE,
    cles: createLocalJWKSet({ keys: [{ ...(await exportJWK(k.publicKey)), kid: "k1", alg: "RS256" }] }),
  });
  app = Fastify();
  app.get("/sensible", { preHandler: [exigerJeton(verificateur), exigerReauthentification()] }, async () => ({ ok: true }));
  app.get("/simple", { preHandler: [exigerJeton(verificateur)] }, async () => ({ ok: true }));
  await app.ready();
});

const jeton = (sur: Record<string, unknown>) =>
  new SignJWT({ sub: "u1", ...sur }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(EMETTEUR).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("5m").sign(cle);
const appeler = (url: string, authorization?: string) => app.inject({ method: "GET", url, ...(authorization ? { headers: { authorization } } : {}) });

describe("exiger-reauthentification [C-003]", () => {
  it("[C-003] … accepte un jeton tout neuf avec double facteur", async () => {
    const r = await appeler("/sensible", `Bearer ${await jeton({ auth_time: MAINTENANT - 5, acr: "mfa" })}`);
    expect(r.statusCode).toBe(200);
  });
  it("[C-003] une route sensible refuse un jeton dont auth_time a plus de 5 minutes", async () => {
    const r = await appeler("/sensible", `Bearer ${await jeton({ auth_time: MAINTENANT - 301, acr: "mfa" })}`);
    expect(r.statusCode).toBe(401);
    expect(r.json().erreur.code).toBe("reauthentification_requise");
  });
  it("[C-003] refuse auth_time absent, non numérique ou dans le futur", async () => {
    for (const sur of [{ acr: "mfa" }, { auth_time: "maintenant", acr: "mfa" }, { auth_time: MAINTENANT + 3600, acr: "mfa" }, { auth_time: null, acr: "mfa" }]) {
      const r = await appeler("/sensible", `Bearer ${await jeton(sur)}`);
      expect(r.statusCode, JSON.stringify(sur)).toBe(401);
      expect(r.json().erreur.code).toBe("reauthentification_requise");
    }
  });
  it("[C-003] refuse un jeton récent sans double facteur (acr absent ou mot de passe seul)", async () => {
    for (const acr of [undefined, "0", "1", "MFA", ["mfa"]]) {
      const r = await appeler("/sensible", `Bearer ${await jeton({ auth_time: MAINTENANT, ...(acr === undefined ? {} : { acr }) })}`);
      expect(r.statusCode, String(acr)).toBe(401);
      expect(r.json().erreur.code).toBe("reauthentification_requise");
    }
  });
  it("[C-003] refuse sans jeton ou avec un en-tête mal formé", async () => {
    expect((await appeler("/sensible")).statusCode).toBe(401);
    for (const h of ["Basic abc", "Bearer", "bearer  x y", `Token ${await jeton({})}`]) expect((await appeler("/sensible", h)).statusCode, h).toBe(401);
  });
  it("[C-003] la réponse ne contient ni le jeton ni le détail de l'échec", async () => {
    const t = await jeton({ auth_time: MAINTENANT - 999, acr: "mfa" });
    const r = await appeler("/sensible", `Bearer ${t}`);
    expect(r.body).not.toContain(t);
    expect(r.body).not.toContain("auth_time");
  });
  it("[C-003] une route non sensible ne demande pas de jeton récent", async () => {
    const r = await appeler("/simple", `Bearer ${await jeton({ auth_time: MAINTENANT - 7200, acr: "1" })}`);
    expect(r.statusCode).toBe(200);
  });
});
