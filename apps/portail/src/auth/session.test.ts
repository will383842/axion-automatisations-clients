import { describe, expect, it } from "vitest";
import { problemesCookie } from "../../../../packages/securite-web/src/cookies.ts";
import { COOKIE_SESSION, cookieEffacer, cookieSession, cookieTransaction, creerMagasin } from "./session.ts";

const IDENTITE = { sub: "u1", role: "comptable", organisation: "3f2b8c1e-9a4d-4b6e-8c5f-1a2b3c4d5e6f", jetonIdentite: "i", jetonAcces: "a", jetonRafraichissement: "r", accesExpireA: 1_000_000 + 300_000 } as const;
const T = { verifier: "V".repeat(43), nonce: "N", retour: "/" };

describe("session du portail", () => {
  it("[LOT6-connexion] transaction à usage unique : un state rejoué est refusé, même après un échec", () => {
    const m = creerMagasin(() => 1_000_000);
    const etat = m.ouvrirTransaction(T) as string;
    expect(m.consommerTransaction(etat)).toMatchObject({ nonce: "N" });
    expect(m.consommerTransaction(etat)).toBeUndefined();
    expect(m.consommerTransaction("inventé")).toBeUndefined();
  });

  it("[LOT6-connexion] nouvel identifiant de session à chaque connexion ; un identifiant inventé par le navigateur ne donne rien", () => {
    const m = creerMagasin(() => 1_000_000);
    const a = m.ouvrirSession(IDENTITE);
    const b = m.ouvrirSession(IDENTITE);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[\w-]{43,}$/);
    expect(m.lireSession("fixé-par-le-navigateur")).toBeUndefined();
    expect(m.lireSession(a.id)?.sub).toBe("u1");
  });

  it("[LOT6-connexion] session : 8 h au plus et 30 min d'inactivité (horloge injectée)", () => {
    let t = 1_000_000;
    const m = creerMagasin(() => t);
    const s = m.ouvrirSession(IDENTITE);
    t += 29 * 60_000;
    expect(m.lireSession(s.id)).toBeDefined();
    t += 29 * 60_000;
    expect(m.lireSession(s.id)).toBeDefined();
    t += 31 * 60_000;
    expect(m.lireSession(s.id)).toBeUndefined();
    const longue = m.ouvrirSession(IDENTITE);
    for (let i = 0; i < 17; i++) { t += 29 * 60_000; m.lireSession(longue.id); }
    expect(m.lireSession(longue.id)).toBeUndefined();
  });

  it("[LOT6-connexion] cookie __Host-session : HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=28800, problemesCookie vide", () => {
    const c = cookieSession("abc", 28800);
    expect(c).toMatch(/^__Host-session=abc; /);
    for (const attendu of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=28800"]) expect(c).toContain(attendu);
    for (const x of [c, cookieTransaction("e"), cookieEffacer(COOKIE_SESSION), cookieEffacer("__Host-transaction")]) expect(problemesCookie(x), x).toEqual([]);
  });

  it("[LOT6-connexion] deux demandes simultanées de jeton d'accès expiré : un seul appel au point token", async () => {
    let t = 1_000_000;
    const m = creerMagasin(() => t);
    const s = m.ouvrirSession(IDENTITE);
    t += 400_000;
    let appels = 0;
    const rafraichir = async () => { appels++; await new Promise((r) => setTimeout(r, 10)); return { jetonAcces: "a2", jetonRafraichissement: "r2", expireDans: 300 }; };
    const [x, y] = await Promise.all([m.jetonAcces(s.id, rafraichir), m.jetonAcces(s.id, rafraichir)]);
    expect([x, y, appels]).toEqual(["a2", "a2", 1]);
    expect(await m.jetonAcces(s.id, rafraichir)).toBe("a2");
    expect(appels).toBe(1);
  });

  it("[LOT6-connexion] rafraîchissement refusé par Keycloak : la session est fermée", async () => {
    let t = 1_000_000;
    const m = creerMagasin(() => t);
    const s = m.ouvrirSession(IDENTITE);
    t += 400_000;
    expect(await m.jetonAcces(s.id, async () => { throw new Error("refusé"); })).toBeUndefined();
    expect(m.lireSession(s.id)).toBeUndefined();
  });

  it("[LOT6-connexion] plafond de transactions atteint : 503 sans nouvelle entrée", () => {
    const m = creerMagasin(() => 1_000_000, 2);
    expect(m.ouvrirTransaction(T)).toBeDefined();
    expect(m.ouvrirTransaction(T)).toBeDefined();
    expect(m.ouvrirTransaction(T)).toBeUndefined();
  });
});
