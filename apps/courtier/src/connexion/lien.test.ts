import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signerLien, verifierLien, type ChargeLien, type CleLien } from "./lien.js";

const T0 = 1_800_000_000_000;
const S = Math.floor(T0 / 1000);
const JOUR = 86_400;
const CLE: CleLien = { kid: "k1", secret: randomBytes(32) };
const charge = (sur: Partial<ChargeLien> = {}): ChargeLien => ({ v: 1, jti: randomUUID(), t: "11111111-1111-4111-8111-111111111111", c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", o: "microsoft-365", l: "22222222-2222-4222-8222-222222222222", iat: S, exp: S + 3600, ...sur });

describe("lien de connexion signé", () => {
  it("[B-092] un lien signé s'ouvre ; charge modifiée, signature tronquée, clé inconnue ou base64 non canonique : même refus neutre", () => {
    const c = charge();
    const lien = signerLien(c, CLE);
    expect(verifierLien(lien, [CLE], T0)).toEqual(c);
    const [v, kid, charge64, signature] = lien.split(".") as [string, string, string, string];
    const autreCharge = Buffer.from(JSON.stringify({ ...c, c: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })).toString("base64url");
    // Dernier caractère de la signature : seuls les 2 derniers bits comptent, un autre caractère donne les mêmes octets.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const dernier = signature.at(-1) as string;
    const jumeau = alphabet[(alphabet.indexOf(dernier) & ~3) | (((alphabet.indexOf(dernier) & 3) + 1) & 3)] as string;
    const refuses = [
      `${v}.${kid}.${autreCharge}.${signature}`,
      `${v}.${kid}.${charge64}.${signature.slice(0, -4)}`,
      `${v}.${kid}.${charge64}.`,
      `${v}.inconnue.${charge64}.${signature}`,
      `${v}.${kid}.${charge64}.${signature.slice(0, -1)}${jumeau}`,
      `${v}.${kid}.${charge64}=.${signature}`,
      `v2.${kid}.${charge64}.${signature}`,
      `${lien}.en-trop`,
      "x".repeat(2000),
      "",
    ];
    for (const r of refuses) expect(verifierLien(r, [CLE], T0)).toBeNull();
    expect(verifierLien(lien, [{ kid: "k1", secret: randomBytes(32) }], T0)).toBeNull();
  });

  it("[B-092] au bout de 7 jours et 1 minute le lien est refusé ; un lien émis pour plus de 7 jours est refusé à la vérification", () => {
    const sept = signerLien(charge({ exp: S + 7 * JOUR }), CLE);
    expect(verifierLien(sept, [CLE], T0 + (7 * JOUR - 60) * 1000)).not.toBeNull();
    expect(verifierLien(sept, [CLE], T0 + (7 * JOUR + 60) * 1000)).toBeNull();
    const huit = signerLien(charge({ exp: S + 8 * JOUR }), CLE);
    expect(verifierLien(huit, [CLE], T0)).toBeNull();
  });
});
