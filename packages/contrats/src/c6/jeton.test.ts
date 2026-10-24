import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emettreJeton } from "./jeton.ts";
import { verifierJeton, type Cle } from "./verifier.ts";

const SECRET = "TEST-NE-PAS-UTILISER-cle-c6-a-0123456789abcdef";
const AUTRE = "TEST-NE-PAS-UTILISER-cle-c6-b-0123456789abcdef";
const T = 1792800000;
const EMAIL = "equipe@exemple.fr";
const cles: Cle[] = [{ kid: "c6-a", secret: SECRET }];
const jamais = () => false;

const decoder = (b: string) => JSON.parse(Buffer.from(b, "base64url").toString("utf8")) as Record<string, unknown>;
const recoder = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Jeton bien signé (clé SECRET) dont la charge est choisie : seul le contrôle du contenu peut le refuser.
function signe(charge: unknown, secret = SECRET): string {
  const brut = typeof charge === "string" ? charge : JSON.stringify(charge);
  const b = Buffer.from(brut).toString("base64url");
  return `${b}.${createHmac("sha256", secret).update(b).digest("base64url")}`;
}
const bonneCharge = { v: 1, kid: "c6-a", jti: randomUUID(), email: EMAIL, iat: T, exp: T + 60 };
// Jeton dont la charge est modifiée mais dont la signature d'origine est gardée.
function falsifier(jeton: string, changement: Record<string, unknown>): string {
  const [charge, signature] = jeton.split(".") as [string, string];
  return `${recoder({ ...decoder(charge), ...changement })}.${signature}`;
}

describe("C6 lien signé", () => {
  it("[LOT0-c6] la charge porte v, kid, jti, email, iat et exp = iat + 60", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    expect(jeton).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const charge = decoder(jeton.split(".")[0] as string);
    expect(Object.keys(charge).sort()).toEqual(["email", "exp", "iat", "jti", "kid", "v"]);
    expect(charge).toMatchObject({ v: 1, kid: "c6-a", email: EMAIL, iat: T, exp: T + 60 });
    expect(charge.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("[C-541] le jeton ne donne jamais de session (verifierJeton ne renvoie que l'e-mail)", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    expect(verifierJeton(cles, jeton, T + 1, jamais)).toEqual({ ok: true, email: EMAIL });
  });

  it("[LOT0-c6] jeton de 60 s accepté, de 61 s refusé", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    expect(verifierJeton(cles, jeton, T + 60, jamais).ok).toBe(true);
    expect(verifierJeton(cles, jeton, T + 61, jamais)).toEqual({ ok: false });
  });

  it("[LOT0-c6] iat dans le futur de plus de 5 s refusé", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T + 5);
    expect(verifierJeton(cles, jeton, T, jamais).ok).toBe(true);
    expect(verifierJeton(cles, emettreJeton(SECRET, "c6-a", EMAIL, T + 6), T, jamais)).toEqual({ ok: false });
  });

  it("[LOT0-c6] jti rejoué refusé, et jti noté seulement après une vérification réussie", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    const vus = new Set<string>();
    const dejaVu = (jti: string) => (vus.has(jti) ? true : (vus.add(jti), false));
    expect(verifierJeton(cles, jeton, T, dejaVu).ok).toBe(true);
    expect(verifierJeton(cles, jeton, T + 1, dejaVu)).toEqual({ ok: false });
    // Un jeton falsifié ne consomme pas le jti du vrai jeton.
    const neuf = emettreJeton(SECRET, "c6-a", EMAIL, T);
    expect(verifierJeton(cles, falsifier(neuf, { email: "autre@exemple.fr" }), T, dejaVu)).toEqual({ ok: false });
    expect(vus.size).toBe(1);
  });

  it("[LOT0-c6] signature d'un autre kid refusée", () => {
    const jeton = emettreJeton(AUTRE, "c6-a", EMAIL, T);
    expect(verifierJeton(cles, jeton, T, jamais)).toEqual({ ok: false });
    expect(verifierJeton(cles, emettreJeton(SECRET, "c6-inconnu", EMAIL, T), T, jamais)).toEqual({ ok: false });
  });

  it("[LOT0-c6] deux clés actives : l'ancienne et la nouvelle sont acceptées", () => {
    const deux: Cle[] = [{ kid: "c6-a", secret: SECRET }, { kid: "c6-b", secret: AUTRE }];
    expect(verifierJeton(deux, emettreJeton(AUTRE, "c6-b", EMAIL, T), T, jamais).ok).toBe(true);
    expect(verifierJeton(deux, emettreJeton(SECRET, "c6-a", EMAIL, T), T, jamais).ok).toBe(true);
  });

  it("[LOT0-c6] falsification de la charge refusée (e-mail, exp, version)", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    for (const changement of [{ email: "autre@exemple.fr" }, { exp: T + 3600 }, { iat: T + 30 }, { jti: "11111111-1111-4111-8111-111111111111" }]) {
      expect(verifierJeton(cles, falsifier(jeton, changement), T, jamais)).toEqual({ ok: false });
    }
  });

  it("[LOT0-c6] version inconnue refusée même bien signée", () => {
    // Charge v:2 correctement signée : seul le contrôle de version la refuse.
    const jeton = signe({ ...bonneCharge, v: 2 });
    expect(verifierJeton(cles, jeton, T, jamais)).toEqual({ ok: false });
  });

  it("[LOT0-c6] jetons mal formés refusés sans exception", () => {
    const bon = emettreJeton(SECRET, "c6-a", EMAIL, T);
    const [charge, signature] = bon.split(".") as [string, string];
    for (const m of ["", ".", "a.b.c", charge, `${charge}.`, `.${signature}`, `${charge}.${signature}.x`, `${charge}.${"A".repeat(10)}`, `!!!.${signature}`, `${charge} .${signature}`]) {
      expect(verifierJeton(cles, m, T, jamais)).toEqual({ ok: false });
    }
    // charge signée mais pas du JSON, ou pas un objet
    for (const brut of ["pas du json", "[1]", "null"]) {
      expect(verifierJeton(cles, signe(brut), T, jamais)).toEqual({ ok: false });
    }
  });

  it("[LOT0-c6] charge à champs mal typés refusée (exp différent de iat + 60, e-mail non texte)", () => {
    expect(verifierJeton(cles, signe({ ...bonneCharge, exp: T + 3600 }), T + 100, jamais)).toEqual({ ok: false });
    expect(verifierJeton(cles, signe({ ...bonneCharge, email: 42 }), T, jamais)).toEqual({ ok: false });
    expect(verifierJeton(cles, signe({ ...bonneCharge, jti: "pas-un-uuid" }), T, jamais)).toEqual({ ok: false });
  });

  it("[C-541] maintenant qui n'est pas un entier sûr est refusé (NaN, Infinity, décimal)", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    for (const m of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, T + 0.5, 2 ** 60]) {
      expect(verifierJeton(cles, jeton, m, jamais)).toEqual({ ok: false });
    }
  });

  it("[C-541] une clé de moins de 32 octets est refusée à l'émission", () => {
    for (const court of ["", "a".repeat(31)]) expect(() => emettreJeton(court, "c6-a", EMAIL, T)).toThrow();
    expect(() => emettreJeton("a".repeat(32), "c6-a", EMAIL, T)).not.toThrow();
    // 16 caractères de 2 octets chacun : 32 octets en UTF-8, acceptés ; 15 caractères : 30 octets, refusés.
    expect(() => emettreJeton("é".repeat(16), "c6-a", EMAIL, T)).not.toThrow();
    expect(() => emettreJeton("é".repeat(15), "c6-a", EMAIL, T)).toThrow();
  });

  it("[C-541] une clé de moins de 32 octets est refusée à la vérification, même si la signature colle", () => {
    for (const court of ["", "a".repeat(31)]) {
      const jeton = signe(bonneCharge, court);
      expect(verifierJeton([{ kid: "c6-a", secret: court }], jeton, T, jamais)).toEqual({ ok: false });
    }
  });

  it("[C-541] une signature malléable (bits de bourrage changés) est refusée", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const dernier = jeton.slice(-1);
    const variante = alphabet[alphabet.indexOf(dernier) ^ 1] as string;
    const modifie = jeton.slice(0, -1) + variante;
    // Même signature une fois décodée : seule la forme canonique permet de la refuser.
    expect(Buffer.from(modifie.split(".")[1] as string, "base64url").equals(Buffer.from(jeton.split(".")[1] as string, "base64url"))).toBe(true);
    expect(verifierJeton(cles, modifie, T, jamais)).toEqual({ ok: false });
    expect(verifierJeton(cles, jeton, T, jamais).ok).toBe(true);
  });

  it("[C-541] le kid doit porter le préfixe c6- : émission et vérification le refusent sinon", () => {
    expect(() => emettreJeton(SECRET, "autre-usage", EMAIL, T)).toThrow();
    const jeton = signe({ ...bonneCharge, kid: "autre-usage" });
    expect(verifierJeton([{ kid: "autre-usage", secret: SECRET }], jeton, T, jamais)).toEqual({ ok: false });
  });

  it("[C-541] l'émetteur applique les règles de l'e-mail du vérificateur", () => {
    for (const mauvais of ["pas un email", "a\"b@exemple.fr", "a<b>@exemple.fr", "a&b@exemple.fr", "a\u0000b@exemple.fr", "a\u202eb@exemple.fr"]) {
      expect(() => emettreJeton(SECRET, "c6-a", mauvais, T)).toThrow();
      expect(verifierJeton(cles, signe({ ...bonneCharge, email: mauvais }), T, jamais)).toEqual({ ok: false });
    }
  });

  it("[C-541] un jeton trop long est refusé avant tout décodage", () => {
    const long = signe({ ...bonneCharge, rempli: "x".repeat(5_000_000) });
    expect(verifierJeton(cles, long, T, jamais)).toEqual({ ok: false });
    expect(verifierJeton(cles, signe({ ...bonneCharge, rempli: "x".repeat(900) }), T, jamais)).toEqual({ ok: false });
  });

  it("[C-541] une entrée inattendue ou une panne de dejaVu est un refus, jamais une exception", () => {
    const jeton = emettreJeton(SECRET, "c6-a", EMAIL, T);
    expect(verifierJeton(cles, 42 as unknown as string, T, jamais)).toEqual({ ok: false });
    expect(verifierJeton(undefined as unknown as Cle[], jeton, T, jamais)).toEqual({ ok: false });
    expect(verifierJeton(cles, jeton, T, () => { throw new Error("panne"); })).toEqual({ ok: false });
  });
});
