import { describe, expect, it } from "vitest";
import { creerMagasin, cookieEffacer, cookieSession, cookieTransaction, lireCookie } from "./session.ts";

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

  it("[LOT3-session] la session dure 8 h (session Keycloak), pas la durée du jeton d'identité", () => {
    let t = 1_000_000;
    const m = creerMagasin(() => t);
    const s = m.ouvrirSession({ sub: "u1", email: "a@exemple.fr", jeton: "j" });
    expect(s.expireA - t).toBe(HUIT_HEURES);
    t += 301_000; // le jeton de 300 s est expiré, la session non
    expect(m.lireSession(s.id)).toBeDefined();
    t += HUIT_HEURES;
    expect(m.lireSession(s.id)).toBeUndefined();
  });

  it("[LOT3-session] le nombre de transactions anonymes est plafonné : au-delà, aucune entrée n'est créée", () => {
    let t = 0;
    const m = creerMagasin(() => t);
    for (let i = 0; i < 10_000; i++) expect(m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" })).toBeDefined();
    expect(m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" })).toBeUndefined();
    t += 601_000; // les anciennes expirent : la purge libère la place
    expect(m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" })).toBeDefined();
  });

  it("[LOT3-session] le magasin est partagé entre les routes même si le module est chargé deux fois", async () => {
    const a = (await import("./session.ts?une")).magasin;
    const b = (await import("./session.ts?deux")).magasin;
    expect(a).toBe(b);
  });

  it("[LOT3-session] chaque ouverture crée un identifiant neuf et la fermeture détruit la session", () => {
    const m = creerMagasin(() => 0);
    const a = m.ouvrirSession({ sub: "u1", email: "a@exemple.fr", jeton: "j" });
    const b = m.ouvrirSession({ sub: "u1", email: "a@exemple.fr", jeton: "j" });
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThanOrEqual(43);
    m.fermerSession(a.id);
    expect(m.lireSession(a.id)).toBeUndefined();
    expect(m.lireSession(b.id)).toBeDefined();
  });

  it("[C-541] une transaction de connexion ne sert qu'une fois et expire en 10 minutes", () => {
    let t = 0;
    const m = creerMagasin(() => t);
    const etat = m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/clients" }) as string;
    expect(m.consommerTransaction(etat)).toEqual({ verifier: "v", nonce: "n", retour: "/clients" });
    expect(m.consommerTransaction(etat)).toBeUndefined();
    const vieux = m.ouvrirTransaction({ verifier: "v", nonce: "n", retour: "/" }) as string;
    t += 601_000;
    expect(m.consommerTransaction(vieux)).toBeUndefined();
  });

  it("[LOT3-session] lireCookie ne prend que le cookie nommé", () => {
    expect(lireCookie("a=1; __Host-session=xyz; b=2", "__Host-session")).toBe("xyz");
    expect(lireCookie("session=xyz", "__Host-session")).toBeUndefined();
    expect(lireCookie(null, "__Host-session")).toBeUndefined();
  });
});
