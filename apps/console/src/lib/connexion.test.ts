import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emailValide } from "../../../../packages/contrats/src/c6/jeton.ts";
import { adresseAutorisation, creerDefi, loginHintValide, retourSur, verifierJeton } from "./connexion.ts";

const CFG = { emetteur: "https://sso.exemple.test/realms/equipe", clientId: "console", origine: "https://console.exemple.test" };
const b64 = (x: object | Buffer) => Buffer.from(x instanceof Buffer ? x : JSON.stringify(x)).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const cles = async () => [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }];
const MAINTENANT = 1_800_000_000;
const base = { iss: CFG.emetteur, aud: "console", azp: "console", sub: "u1", email: "a@exemple.fr", nonce: "n1", acr: "mfa", amr: ["pwd", "otp"], auth_time: MAINTENANT - 5, iat: MAINTENANT - 5, exp: MAINTENANT + 300 };
function jeton(charge: object = {}, options: { alg?: string; cle?: KeyObject; signature?: boolean } = {}) {
  const entete = b64({ alg: options.alg ?? "RS256", kid: "k1", typ: "JWT" });
  const corps = b64({ ...base, ...charge });
  const signature = options.signature === false ? "" : sign("sha256", Buffer.from(`${entete}.${corps}`), options.cle ?? privateKey).toString("base64url");
  return `${entete}.${corps}.${signature}`;
}
const verifier = (j: string, extra: object = {}) => verifierJeton(j, { ...CFG, nonce: "n1", maintenant: MAINTENANT * 1000, cles, ...extra });

describe("connexion de l'équipe : adresse d'autorisation", () => {
  it("[C-541] l'adresse force prompt=login, max_age=0 et acr_values=mfa à chaque ouverture", () => {
    const url = new URL(adresseAutorisation(CFG, creerDefi(), "a@exemple.fr"));
    expect(url.origin + url.pathname).toBe("https://sso.exemple.test/realms/equipe/protocol/openid-connect/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: "console", scope: "openid", prompt: "login", max_age: "0", acr_values: "mfa", redirect_uri: "https://console.exemple.test/api/auth/rappel", login_hint: "a@exemple.fr", code_challenge_method: "S256" });
  });

  it("[C-541] PKCE S256 : le défi est le SHA-256 du vérificateur ; state et nonce changent à chaque appel", () => {
    const a = creerDefi();
    const b = creerDefi();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(new Set([a.verifier, b.verifier, a.state, b.state, a.nonce, b.nonce]).size).toBe(6);
    expect(new URL(adresseAutorisation(CFG, a)).searchParams.has("login_hint")).toBe(false);
  });

  it("[C-404] login_hint : une adresse e-mail courte, sans injection, sinon refus", () => {
    expect(loginHintValide("Prénom.Nom+test@Exemple.fr")).toBe(true);
    const mauvais = ["", "pas-un-mail", "a b@exemple.fr", "a@exemple.fr&prompt=none", "a@exemple.fr\r\nX: 1", "a@@exemple.fr", "<x>@exemple.fr", `${"a".repeat(250)}@exemple.fr`, `${"a".repeat(65)}@exemple.fr`, "a@exemple.fr\u202e"];
    for (const m of mauvais) expect(loginHintValide(m), m).toBe(false);
  });

  it("[C-541] la console accepte tout e-mail que le contrat C6 accepte (apostrophe, domaine sans point), dans les limites de 254 et 64", () => {
    for (const m of ["o'neil@exemple.fr", "a@b", "a#x@exemple.fr", "a@exemple.fr,b", "Prénom.Nom+test@Exemple.fr"]) {
      expect(emailValide(m), m).toBe(true);
      expect(loginHintValide(m), m).toBe(true);
    }
    const tropLong = `a@${"b".repeat(253)}`;
    expect(loginHintValide(tropLong)).toBe(false);
  });

  it("[LOT3-session] un retour vers une autre origine est refusé (seul un chemin local passe)", () => {
    expect(retourSur("/clients?vue=a")).toBe("/clients?vue=a");
    for (const m of ["//autre.test", "/\\autre.test", "https://autre.test", "https:", "javascript:alert(1)", "/\t/autre.test", "/%0d%0aX", "\\\\autre.test", "autre", "/connexion", "/api/auth/rappel", "/entree", "/entree#j=x", "/entree?a=1", "/%65ntree", "/%63onnexion", null, ""]) expect(retourSur(m), String(m)).toBe("/");
  });
});

describe("connexion de l'équipe : jeton d'identité", () => {
  it("[C-541] un jeton signé, frais, avec acr mfa et un second facteur est accepté", async () => {
    expect(await verifier(jeton())).toMatchObject({ sub: "u1", email: "a@exemple.fr" });
  });

  it("[C-541] un jeton sans acr de double facteur est refusé côté serveur", async () => {
    for (const charge of [{ acr: "1" }, { acr: undefined }, { amr: ["pwd"] }, { amr: undefined }, { amr: "otp" }]) await expect(verifier(jeton(charge)), JSON.stringify(charge)).rejects.toThrow();
  });

  it("[C-541] une session Keycloak déjà ouverte ne dispense pas du double facteur (authentification ancienne refusée)", async () => {
    await expect(verifier(jeton({ auth_time: MAINTENANT - 3600 }))).rejects.toThrow(/auth_time/);
    await expect(verifier(jeton({ auth_time: undefined }))).rejects.toThrow(/auth_time/);
  });

  it("[C-541] acr ou amr forgé : signature fausse, absente ou algorithme faible refusés", async () => {
    const autre = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(verifier(jeton({}, { cle: autre }))).rejects.toThrow();
    await expect(verifier(jeton({}, { signature: false }))).rejects.toThrow();
    await expect(verifier(jeton({}, { alg: "none" }))).rejects.toThrow();
    await expect(verifier(jeton({}, { alg: "HS256" }))).rejects.toThrow();
    await expect(verifier("pas.un.jeton.du-tout")).rejects.toThrow();
  });

  it("[C-541] un jeton du royaume clients, d'un autre client OIDC, expiré ou au nonce rejoué est refusé", async () => {
    await expect(verifier(jeton({ iss: "https://sso.exemple.test/realms/clients" }))).rejects.toThrow(/iss/);
    await expect(verifier(jeton({ aud: "portail", azp: "portail" }))).rejects.toThrow(/aud/);
    await expect(verifier(jeton({ aud: ["console", "portail"], azp: "portail" }))).rejects.toThrow(/azp/);
    await expect(verifier(jeton({ exp: MAINTENANT - 1 }))).rejects.toThrow(/exp/);
    await expect(verifier(jeton({ nonce: "autre" }))).rejects.toThrow(/nonce/);
    await expect(verifier(jeton({ azp: "portail" }))).rejects.toThrow(/azp/);
    await expect(verifier(jeton({ sub: undefined }))).rejects.toThrow();
  });

  it("[C-541] email absent du jeton (portées du royaume) : la connexion reste possible, l'identité est sub", async () => {
    expect(await verifier(jeton({ email: undefined }))).toEqual({ sub: "u1", email: undefined });
    expect((await verifier(jeton({ email: 42 }))).email).toBeUndefined();
  });

  it("[C-541] une clé du royaume réservée au chiffrement (use=enc) ne vérifie jamais une signature", async () => {
    const chiffrement = async () => [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RSA-OAEP", use: "enc" }];
    await expect(verifier(jeton(), { cles: chiffrement })).rejects.toThrow(/signature/);
  });
});
