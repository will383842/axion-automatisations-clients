import { describe, expect, it } from "vitest";
import { PLAFOND_TRANSACTIONS, creerMagasin, cookieEffacer, cookieSession, cookieTransaction, lireCookie } from "./session.ts";

const HUIT_HEURES = 8 * 3600 * 1000;

describe("session de la console", () => {
  it("[LOT3-session] le cookie est HttpOnly, Secure, SameSite=Strict, préfixe __Host-", () => {
    const c = cookieSession("abc", 3600);
    expect(c.startsWith("__Host-session=abc")).toBe(true);
    for (const attribut of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=3600"]) expect(c).toContain(attribut);
    expect(c).not.toContain("Domain");
    expect(cookieEffacer("__Host-session")).toContain("Max-Age=0");
  });

  it("[LOT3-session] le cookie de transaction est court, HttpOnly, Secure et SameSite=Lax (retour de Keycloak)", () => {
    const c = cookieTransaction("etat");
    for (const attribut of ["__Host-transaction=etat", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) expect(c).toContain(attribut);
  });

  it("[LOT3-session] la session dure 8 h au plus et 30 min d'inactivité, sans lien avec l'exp du jeton (5 min)", () => {
    let t = 1_000_000;
    const m = creerMagasin(() => t);
    const s = m.ouvrirSession({ sub: "u1", jeton: "j" });
    t += 6 * 60_000; // bien au-delà des 5 minutes du jeton d'identité
    expect(m.lireSession(s.id)).toBeDefined();
    const inactive = m.ouvrirSession({ sub: "u2", jeton: "j" });
    t += 31 * 60_000;
    expect(m.lireSession(inactive.id)).toBeUndefined();
    // une activité toutes les 20 minutes prolonge la session, mais jamais au-delà de 8 h
    for (let i = 0; i < 20; i++) { t += 20 * 60_000; if (t - 1_000_000 < HUIT_HEURES) expect(m.lireSession(s.id), String(i)).toBeDefined(); }
    expect(t - 1_000_000).toBeGreaterThan(HUIT_HEURES);
    expect(m.lireSession(s.id)).toBeUndefined();
  });

  it("[LOT3-session] l'e-mail est facultatif : l'identité de la session est sub", () => {
    const m = creerMagasin(() => 0);
    const s = m.ouvrirSession({ sub: "u1", jeton: "j" });
    expect(m.lireSession(s.id)).toMatchObject({ sub: "u1" });
  });

  it("[LOT3-session] les transactions de connexion ouvertes sont plafonnées (mémoire non authentifiée)", () => {
    let t = 0;
    const m = creerMagasin(() => t, 3);
    for (let i = 0; i < 3; i++) expect(m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" })).toBeTypeOf("string");
    expect(m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" })).toBeUndefined();
    t += 601_000; // les anciennes expirent : la place revient
    expect(m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" })).toBeTypeOf("string");
    expect(PLAFOND_TRANSACTIONS).toBeGreaterThanOrEqual(1000);
  });

  it("[LOT3-session] le magasin est ancré sur globalThis : deux chargements du module partagent les mêmes sessions", async () => {
    const { vi } = await import("vitest");
    const a = await import("./session.ts");
    vi.resetModules();
    const b = await import("./session.ts?second");
    expect(b.magasin).toBe(a.magasin);
  });

  it("[LOT3-session] chaque ouverture crée un identifiant neuf et la fermeture détruit la session", () => {
    const m = creerMagasin(() => 0);
    const a = m.ouvrirSession({ sub: "u1", jeton: "j" });
    const b = m.ouvrirSession({ sub: "u1", jeton: "j" });
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThanOrEqual(43);
    m.fermerSession(a.id);
    expect(m.lireSession(a.id)).toBeUndefined();
    expect(m.lireSession(b.id)).toBeDefined();
  });

  it("[C-541] une transaction de connexion ne sert qu'une fois et expire en 10 minutes", () => {
    let t = 0;
    const m = creerMagasin(() => t);
    const etat = m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/clients" });
    expect(m.consommerTransaction(etat)).toEqual({ verifier: "v", nonce: "n", retour: "/clients" });
    expect(m.consommerTransaction(etat)).toBeUndefined();
    const vieux = m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" });
    t += 601_000;
    expect(m.consommerTransaction(vieux)).toBeUndefined();
  });

  it("[LOT3-session] lireCookie ne prend que le cookie nommé", () => {
    expect(lireCookie("a=1; __Host-session=xyz; b=2", "__Host-session")).toBe("xyz");
    expect(lireCookie("session=xyz", "__Host-session")).toBeUndefined();
    expect(lireCookie(null, "__Host-session")).toBeUndefined();
  });
});
