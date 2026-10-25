import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { creerVerificateur, type Verificateur } from "./oidc.ts";

const EMETTEUR = "https://sso.socle.test/realms/equipe";
const AUDIENCE = "api-equipe";

let verificateur: Verificateur;
let cle: CryptoKey;
let autreCle: CryptoKey;
let jwkPublique: JWK;

beforeAll(async () => {
  const a = await generateKeyPair("RS256");
  const b = await generateKeyPair("RS256");
  cle = a.privateKey;
  autreCle = b.privateKey;
  jwkPublique = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  verificateur = creerVerificateur({ emetteur: EMETTEUR, audience: AUDIENCE, cles: createLocalJWKSet({ keys: [jwkPublique] }) });
});

async function jeton(sur: Record<string, unknown> = {}, opts: { cle?: CryptoKey; kid?: string; emetteur?: string; audience?: string; exp?: string | number; nbf?: number } = {}) {
  const j = new SignJWT({ sub: "u1", ...sur })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuer(opts.emetteur ?? EMETTEUR)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m");
  if (opts.nbf !== undefined) j.setNotBefore(opts.nbf);
  return j.sign(opts.cle ?? cle);
}
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("oidc : vérification des jetons", () => {
  it("[LOT1-kc] accepte un jeton valide et rend ses revendications", async () => {
    const r = await verificateur(await jeton({ auth_time: 10 }));
    expect(r.sub).toBe("u1");
  });
  it("[LOT1-kc] oidc refuse un jeton du royaume clients sur une route de la console", async () => {
    await expect(verificateur(await jeton({}, { emetteur: "https://sso.socle.test/realms/clients" }))).rejects.toThrow();
  });
  it("[LOT1-kc] refuse une mauvaise audience (aussi quand elle n'est qu'une parmi d'autres)", async () => {
    await expect(verificateur(await jeton({}, { audience: "account" }))).rejects.toThrow();
  });
  it("[LOT1-kc] refuse un jeton expiré et un jeton pas encore valide", async () => {
    const passe = Math.floor(Date.now() / 1000) - 3600;
    await expect(verificateur(await jeton({}, { exp: passe }))).rejects.toThrow();
    await expect(verificateur(await jeton({}, { nbf: Math.floor(Date.now() / 1000) + 3600 }))).rejects.toThrow();
  });
  it("[LOT1-kc] refuse un jeton signé par une clé inconnue, avec le bon kid", async () => {
    await expect(verificateur(await jeton({}, { cle: autreCle }))).rejects.toThrow();
  });
  it("[LOT1-kc] refuse un kid inconnu", async () => {
    await expect(verificateur(await jeton({}, { kid: "autre" }))).rejects.toThrow();
  });
  it("[LOT1-kc] refuse alg none", async () => {
    const t = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "u1", iss: EMETTEUR, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    await expect(verificateur(t)).rejects.toThrow();
  });
  it("[LOT1-kc] refuse la confusion d'algorithme : HS256 signé avec la clé publique", async () => {
    const { createHmac } = await import("node:crypto");
    const entete = b64({ alg: "HS256", typ: "JWT", kid: "k1" });
    const corps = b64({ sub: "u1", iss: EMETTEUR, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 });
    const sig = createHmac("sha256", JSON.stringify(jwkPublique)).update(`${entete}.${corps}`).digest("base64url");
    await expect(verificateur(`${entete}.${corps}.${sig}`)).rejects.toThrow();
  });
  it("[LOT1-kc] refuse un jeton sans date d'expiration", async () => {
    const t = await new SignJWT({ sub: "u1" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(EMETTEUR).setAudience(AUDIENCE).sign(cle);
    await expect(verificateur(t)).rejects.toThrow();
  });
  it("[LOT1-kc] refuse une chaîne qui n'est pas un jeton", async () => {
    await expect(verificateur("n'importe quoi")).rejects.toThrow();
  });
});
