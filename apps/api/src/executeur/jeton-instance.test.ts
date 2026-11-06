import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";

// Espion sur la comparaison : le vrai timingSafeEqual est appelé, on compte seulement les appels.
vi.mock("node:crypto", async (original) => {
  const reel = await original<typeof import("node:crypto")>();
  return { ...reel, timingSafeEqual: vi.fn(reel.timingSafeEqual) };
});
import { DUREE_JETON_MS, emettreJetonInstance, verifierJetonInstance } from "./jeton-instance.js";

type Cles = Parameters<typeof emettreJetonInstance>[0];
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const HEURE = 3600_000;
const NOW = Date.UTC(2026, 10, 2, 8, 0, 0);
const INSTANCE = randomUUID();
const AUTRE_INSTANCE = randomUUID();
const CELLULE = "cellule-un";

// Faux coffre : clés par canal ; « ji » pour les jetons d'instance, « c4-<cellule> » pour la signature des requêtes.
function fauxCoffre() {
  const kv = new Map<string, CleEchange[]>();
  const appels: string[] = [];
  const cles: Cles = {
    async cleActive(canal: string, sens: Sens) {
      appels.push(`active:${canal}:${sens}`);
      const k = kv.get(canal)?.[0];
      if (!k) throw new Error("introuvable");
      return k;
    },
    async clesAcceptees(canal: string, sens: Sens) {
      appels.push(`acceptees:${canal}:${sens}`);
      return kv.get(canal) ?? [];
    },
  };
  const poser = (canal: string, ...secrets: Buffer[]) => kv.set(canal, secrets.map((secret, i) => ({ kid: `k${i}`, secret })));
  return { cles, poser, appels };
}
const signer = (cle: Buffer, texte: string) => b64(createHmac("sha256", cle).update(texte).digest());
// Jeton forgé avec une clé donnée et une charge libre (pour les attaques).
const forger = (cle: Buffer, charge: unknown) => {
  const p = `ji1.${b64(JSON.stringify(charge))}`;
  return `${p}.${signer(cle, p)}`;
};
const charge = (extra: Record<string, unknown> = {}) => ({ v: 1, instanceId: INSTANCE, cellule: CELLULE, exp: Math.floor((NOW + HEURE) / 1000), ...extra });
const attendu = { instanceId: INSTANCE, cellule: CELLULE };

let coffre: ReturnType<typeof fauxCoffre>;
let cleJi: Buffer;
let cleCellule: Buffer;
beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
  coffre = fauxCoffre();
  cleJi = randomBytes(32);
  cleCellule = randomBytes(32);
  coffre.poser("ji", cleJi);
  coffre.poser(`c4-${CELLULE}`, cleCellule);
});

describe("jeton d'instance (C-017)", () => {
  it("[C-017] un jeton émis est de la forme ji1.<charge>.<signature>, vaut 24 h et se vérifie", async () => {
    const jeton = await emettreJetonInstance(coffre.cles, attendu, () => NOW);
    expect(jeton).toMatch(/^ji1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(jeton.split(".")).toHaveLength(3);
    expect(DUREE_JETON_MS).toBe(24 * HEURE);
    const charge = JSON.parse(Buffer.from(jeton.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    expect(charge).toEqual({ v: 1, instanceId: INSTANCE, cellule: CELLULE, exp: Math.floor((NOW + 24 * HEURE) / 1000) });
    await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW)).resolves.toEqual(charge);
  });

  it("[C-017] l'émission signe avec la clé active du canal ji, jamais avec la clé de la cellule", async () => {
    const jeton = await emettreJetonInstance(coffre.cles, attendu, () => NOW);
    expect(coffre.appels).toEqual(["active:ji:emission"]);
    const [, p, s] = jeton.split(".");
    expect(s).toBe(signer(cleJi, `ji1.${p}`));
    expect(s).not.toBe(signer(cleCellule, `ji1.${p}`));
  });

  it("[C-017] la vérification lit les clés acceptées du canal ji (rotation : l'ancienne clé vaut encore)", async () => {
    const ancienne = randomBytes(32);
    const jeton = forger(ancienne, charge());
    coffre.poser("ji", cleJi, ancienne);
    await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW)).resolves.toMatchObject({ instanceId: INSTANCE });
    expect(coffre.appels).toContain("acceptees:ji:emission");
    coffre.poser("ji", cleJi);
    await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW)).resolves.toBeNull();
  });

  it("[C-017] un jeton expiré est refusé, à la seconde près", async () => {
    const jeton = forger(cleJi, charge());
    await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW + HEURE - 1000)).resolves.not.toBeNull();
    await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW + HEURE)).resolves.toBeNull();
    await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW + 30 * HEURE)).resolves.toBeNull();
  });

  it("[C-017] un jeton de version 2 (ou sans version) est refusé même bien signé", async () => {
    for (const v of [2, 0, "1", null, undefined]) {
      await expect(verifierJetonInstance(coffre.cles, forger(cleJi, charge({ v })), attendu, () => NOW), String(v)).resolves.toBeNull();
    }
  });

  it("[C-017] une clé en plus dans la charge est refusée, comme une clé en moins", async () => {
    await expect(verifierJetonInstance(coffre.cles, forger(cleJi, charge({ tenant_id: randomUUID() })), attendu, () => NOW)).resolves.toBeNull();
    const sansExp: Record<string, unknown> = charge();
    delete sansExp["exp"];
    await expect(verifierJetonInstance(coffre.cles, forger(cleJi, sansExp), attendu, () => NOW)).resolves.toBeNull();
  });

  it("[C-017] @isolation un jeton signé par la clé HMAC de la cellule est refusé", async () => {
    await expect(verifierJetonInstance(coffre.cles, forger(cleCellule, charge()), attendu, () => NOW)).resolves.toBeNull();
    // même si, par erreur de configuration, la clé de la cellule était aussi posée sous ji : la vérification ne lit que ji
    expect(coffre.appels.every((a) => !a.includes("c4-"))).toBe(true);
  });

  it("[C-017] @isolation un jeton d'une autre instance ou d'une autre cellule est refusé", async () => {
    const pourAutre = forger(cleJi, charge({ instanceId: AUTRE_INSTANCE }));
    await expect(verifierJetonInstance(coffre.cles, pourAutre, attendu, () => NOW)).resolves.toBeNull();
    await expect(verifierJetonInstance(coffre.cles, forger(cleJi, charge()), { instanceId: AUTRE_INSTANCE, cellule: CELLULE }, () => NOW)).resolves.toBeNull();
    await expect(verifierJetonInstance(coffre.cles, forger(cleJi, charge()), { instanceId: INSTANCE, cellule: "cellule-deux" }, () => NOW)).resolves.toBeNull();
  });

  it("[C-017] la signature est comparée avec timingSafeEqual, et une signature de mauvaise longueur est refusée sans exception", async () => {
    const jeton = await emettreJetonInstance(coffre.cles, attendu, () => NOW);
    vi.mocked(timingSafeEqual).mockClear();
    await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW)).resolves.not.toBeNull();
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalled();
    for (const [a, b] of vi.mocked(timingSafeEqual).mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
    const [pre, p] = jeton.split(".");
    for (const mauvaise of ["", "AA", b64(randomBytes(31)), b64(randomBytes(33)), b64(randomBytes(64))]) {
      await expect(verifierJetonInstance(coffre.cles, `${pre}.${p}.${mauvaise}`, attendu, () => NOW), mauvaise).resolves.toBeNull();
    }
  });

  it.each(["", "ji1", "ji1..", "ji1.a.b.c", "ji2.e30.AAAA", "Bearer x", "ji1.%%%.%%%", `ji1.${"A".repeat(5000)}.${"A".repeat(43)}`, "ji1.bm90LWpzb24.AAAA", "ji1.W10.AAAA", "ji1.bnVsbA.AAAA"])(
    "[C-017] un jeton mal formé %j est refusé sans exception",
    async (jeton) => {
      await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW)).resolves.toBeNull();
    },
  );

  it("[C-017] un identifiant d'instance qui n'est pas un UUID ou une cellule mal formée ne s'émet pas", async () => {
    await expect(emettreJetonInstance(coffre.cles, { instanceId: "x", cellule: CELLULE }, () => NOW)).rejects.toThrow();
    for (const cellule of ["", "A", "a_b", "a/b", "-a", "a".repeat(65)]) {
      await expect(emettreJetonInstance(coffre.cles, { instanceId: INSTANCE, cellule }, () => NOW), cellule).rejects.toThrow();
    }
  });

  it("[C-017] un jeton mal formé, périmé ou visant une autre instance est refusé sans aucun appel au coffre (faux coffre espion)", async () => {
    const bons = ["", "ji1.a.b", "ji1.W10.AAAA"];
    const perime = forger(cleJi, charge({ exp: Math.floor((NOW - 1000) / 1000) }));
    const autre = forger(cleJi, charge({ instanceId: AUTRE_INSTANCE }));
    const autreCellule = forger(cleJi, charge({ cellule: "cellule-deux" }));
    for (const jeton of [...bons, perime, autre, autreCellule]) await expect(verifierJetonInstance(coffre.cles, jeton, attendu, () => NOW)).resolves.toBeNull();
    expect(coffre.appels).toEqual([]);
  });

  it("[C-017] une panne du coffre rend null au lieu de lever", async () => {
    const jeton = forger(cleJi, charge());
    const panne = { cleActive: coffre.cles.cleActive, clesAcceptees: async () => { throw new Error("coffre indisponible"); } };
    await expect(verifierJetonInstance(panne, jeton, attendu, () => NOW)).resolves.toBeNull();
  });
});
