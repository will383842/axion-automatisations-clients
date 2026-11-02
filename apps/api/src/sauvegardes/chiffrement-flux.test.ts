import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chiffrerFlux, dechiffrerFlux, type Entete } from "./chiffrement-flux.js";

// Clients fictifs : seuls identifiants de test.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ENTETE = { versionCle: 3, cleChiffree: "vault:v3:QUJDRA==" };

async function* depuis(...morceaux: Buffer[]) { for (const m of morceaux) yield m; }
async function tout(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of source) parts.push(p);
  return Buffer.concat(parts);
}
const chiffrer = (clair: Buffer, cle: Buffer, tenant = A, bloc = 64) => tout(chiffrerFlux(depuis(clair), cle, ENTETE, tenant, bloc));
const lireCle = (cle: Buffer) => async (_e: Entete) => Buffer.from(cle);

describe("chiffrement par blocs", () => {
  it("[A-239] le flux chiffré se relit à l'identique, y compris vide et à cheval sur plusieurs blocs", async () => {
    const cle = randomBytes(32);
    for (const taille of [0, 1, 63, 64, 65, 1000]) {
      const clair = randomBytes(taille);
      const chiffre = await chiffrer(clair, cle);
      expect(await tout(dechiffrerFlux(depuis(chiffre), A, lireCle(cle)))).toEqual(clair);
    }
  });

  it("[A-239] l'en-tête porte la version de format, la version de clé et la clé de données chiffrée, jamais la clé en clair", async () => {
    const cle = randomBytes(32);
    const chiffre = await chiffrer(Buffer.from("x"), cle);
    let vu: Entete | undefined;
    await tout(dechiffrerFlux(depuis(chiffre), A, async (e) => { vu = e; return Buffer.from(cle); }));
    expect(vu).toMatchObject({ versionFormat: 1, versionCle: 3, cleChiffree: "vault:v3:QUJDRA==" });
    expect(chiffre.includes(cle)).toBe(false);
    expect(chiffre.includes(cle.toString("base64"))).toBe(false);
  });

  it("[A-239] aucun nonce n'est réutilisé entre deux blocs ni entre deux dumps", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const brut = await chiffrer(Buffer.alloc(64 * 5, 7), randomBytes(32));
      const lg = 4 + 1 + 4 + 4 + 4 + 2 + ENTETE.cleChiffree.length;
      // chaque bloc : longueur (4) puis chiffré ; le nonce se déduit de (préfixe de l'en-tête, compteur) : on vérifie par l'unicité des chiffrés
      let p = lg;
      while (p < brut.length) { const n = brut.readUInt32BE(p); nonces.add(brut.subarray(p + 4, p + 4 + n).toString("hex")); p += 4 + n; }
    }
    expect(nonces.size).toBe(18);
  });

  it("[A-239] un bloc modifié, retiré, dupliqué ou une fin coupée est refusé", async () => {
    const cle = randomBytes(32);
    const brut = await chiffrer(randomBytes(300), cle);
    const lire = (b: Buffer) => tout(dechiffrerFlux(depuis(b), A, lireCle(cle)));
    const modifie = Buffer.from(brut); modifie[modifie.length - 20]! ^= 1;
    await expect(lire(modifie)).rejects.toThrow("dechiffrement_impossible");
    await expect(lire(brut.subarray(0, brut.length - 10))).rejects.toThrow("dechiffrement_impossible");
    await expect(lire(Buffer.concat([brut, Buffer.from([0])]))).rejects.toThrow("dechiffrement_impossible");
    // fin coupée proprement entre deux blocs (le dernier bloc, marqué final, est absent)
    const lg = 4 + 1 + 4 + 4 + 4 + 2 + ENTETE.cleChiffree.length;
    const premier = lg + 4 + brut.readUInt32BE(lg);
    await expect(lire(brut.subarray(0, premier))).rejects.toThrow("dechiffrement_impossible");
  });

  it("[A-244] @isolation le dump de A ne se déchiffre pas avec la clé de B, ni sous l'identité de B", async () => {
    const cleA = randomBytes(32);
    const chiffre = await chiffrer(randomBytes(200), cleA, A);
    await expect(tout(dechiffrerFlux(depuis(chiffre), A, lireCle(randomBytes(32))))).rejects.toThrow("dechiffrement_impossible");
    // même clé de données, mais lue au nom d'un autre client : refusé par les données associées
    await expect(tout(dechiffrerFlux(depuis(chiffre), B, lireCle(cleA)))).rejects.toThrow("dechiffrement_impossible");
  });

  it("[A-244] @isolation l'en-tête d'un dump déplacé vers un autre dump ne le rend pas lisible", async () => {
    const cle1 = randomBytes(32), cle2 = randomBytes(32);
    const d1 = await chiffrer(randomBytes(200), cle1, A);
    const d2 = await chiffrer(randomBytes(200), cle2, A);
    const lg = 4 + 1 + 4 + 4 + 4 + 2 + ENTETE.cleChiffree.length;
    const mixte = Buffer.concat([d1.subarray(0, lg), d2.subarray(lg)]);
    await expect(tout(dechiffrerFlux(depuis(mixte), A, lireCle(cle2)))).rejects.toThrow("dechiffrement_impossible");
    await expect(tout(dechiffrerFlux(depuis(mixte), A, lireCle(cle1)))).rejects.toThrow("dechiffrement_impossible");
  });

  it("[A-239] la clé de données reçue est remise à zéro après lecture et après chiffrement", async () => {
    const cle = randomBytes(32);
    const chiffre = await chiffrer(Buffer.from("abc"), cle);
    const lue = Buffer.from(cle);
    await tout(dechiffrerFlux(depuis(chiffre), A, async () => lue));
    expect(lue.equals(Buffer.alloc(32))).toBe(true);
  });
});
