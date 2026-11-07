import { createHash, generateKeyPairSync, sign, createHmac, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adresseAutorisation, creerDefi, retourSur, verifierJeton } from "./connexion.ts";

const CFG = { emetteur: "https://sso.exemple.test/realms/clients", clientId: "portail", origine: "https://portail.exemple.test" };
const ORG = "/organisations/3f2b8c1e-9a4d-4b6e-8c5f-1a2b3c4d5e6f";
const b64 = (x: object | Buffer) => Buffer.from(x instanceof Buffer ? x : JSON.stringify(x)).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const cles = async () => [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }];
const MAINTENANT = 1_800_000_000;
const base = { iss: CFG.emetteur, aud: "portail", azp: "portail", sub: "u1", nonce: "n1", iat: MAINTENANT - 5, exp: MAINTENANT + 300, roles_portail: ["comptable"], organisations: [ORG] };
function jeton(charge: object = {}, options: { alg?: string; cle?: KeyObject; signature?: boolean } = {}) {
  const entete = b64({ alg: options.alg ?? "RS256", kid: "k1", typ: "JWT" });
  const corps = b64({ ...base, ...charge });
  const signature = options.signature === false ? "" : sign("sha256", Buffer.from(`${entete}.${corps}`), options.cle ?? privateKey).toString("base64url");
  return `${entete}.${corps}.${signature}`;
}
const verifier = (j: string, extra: object = {}) => verifierJeton(j, { ...CFG, nonce: "n1", maintenant: MAINTENANT * 1000, cles, ...extra });

describe("connexion du portail", () => {
  it("[B-128] l'adresse d'autorisation vise le royaume clients : code, PKCE S256, state et nonce aléatoires, redirect_uri = origine du portail + /api/auth/rappel", () => {
    const a = creerDefi();
    const b = creerDefi();
    const url = new URL(adresseAutorisation(CFG, a));
    expect(url.origin + url.pathname).toBe("https://sso.exemple.test/realms/clients/protocol/openid-connect/auth");
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({ response_type: "code", client_id: "portail", scope: "openid", redirect_uri: "https://portail.exemple.test/api/auth/rappel", code_challenge_method: "S256", state: a.state, nonce: a.nonce });
    expect(p["code_challenge"]).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(["prompt", "max_age", "acr_values"].filter((k) => k in p)).toEqual([]);
    expect(new Set([a.verifier, b.verifier, a.state, b.state, a.nonce, b.nonce]).size).toBe(6);
  });

  it("[B-128] un jeton d'identité du royaume de l'équipe est refusé au portail", async () => {
    expect(await verifier(jeton())).toMatchObject({ sub: "u1", role: "comptable", organisation: "3f2b8c1e-9a4d-4b6e-8c5f-1a2b3c4d5e6f" });
    await expect(verifier(jeton({ iss: "https://sso.exemple.test/realms/equipe" }))).rejects.toThrow(/iss/);
  });

  it("[LOT6-connexion] jeton refusé : alg none, HS256, signature altérée après ajout de « administrateur » dans roles_portail, aud ou azp d'un autre client, exp dépassé, nonce différent", async () => {
    const valide = jeton();
    const [e, , s] = valide.split(".");
    const altere = `${e}.${b64({ ...base, roles_portail: ["administrateur"] })}.${s}`;
    const hs = (() => { const h = b64({ alg: "HS256", kid: "k1" }); const c = b64(base); return `${h}.${c}.${createHmac("sha256", "x").update(`${h}.${c}`).digest("base64url")}`; })();
    const cas = [jeton({}, { alg: "none", signature: false }), hs, altere, jeton({ aud: "autre" }), jeton({ azp: "autre" }), jeton({ exp: MAINTENANT - 1 }), jeton({ nonce: "autre" }), jeton({}, { cle: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), "a.b"];
    for (const c of cas) await expect(verifier(c)).rejects.toThrow();
  });

  it("[LOT6-connexion] revendications refusées : aucune organisation, deux organisations, groupe hors /organisations/{uuid}, aucun rôle, deux rôles, rôle inconnu ou « dirigeant »", async () => {
    const autre = "/organisations/aaaaaaaa-9a4d-4b6e-8c5f-1a2b3c4d5e6f";
    const mauvais: object[] = [
      { organisations: [] }, { organisations: undefined }, { organisations: [ORG, autre] }, { organisations: ["/organisations"] }, { organisations: ["/equipe/3f2b8c1e-9a4d-4b6e-8c5f-1a2b3c4d5e6f"] },
      { organisations: ["/organisations/pas-un-uuid"] }, { organisations: [`${ORG}/sous`] }, { organisations: ORG },
      { roles_portail: [] }, { roles_portail: undefined }, { roles_portail: ["comptable", "administrateur"] }, { roles_portail: ["inconnu"] }, { roles_portail: ["dirigeant"] }, { roles_portail: "comptable" },
    ];
    for (const m of mauvais) await expect(verifier(jeton(m)), JSON.stringify(m)).rejects.toThrow();
    for (const r of ["administrateur", "utilisateur", "lecture_seule", "comptable"]) expect((await verifier(jeton({ roles_portail: [r] }))).role).toBe(r);
  });

  it("[LOT6-connexion] retour : double barre oblique, barre oblique inverse, adresse absolue, formes encodées, retour à la ligne encodé, /api/auth/… donnent « / »", () => {
    expect(retourSur("/automatisations?vue=a")).toBe("/automatisations?vue=a");
    for (const m of ["//autre.test", "/\\autre.test", "https://autre.test", "javascript:alert(1)", "/\t/autre.test", "/%0d%0aX", "/%5cautre.test", "\\\\autre.test", "autre", "/api/auth/rappel", "/api/%61uth/rappel", null, ""]) expect(retourSur(m), String(m)).toBe("/");
  });
});
