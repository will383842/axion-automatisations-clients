import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chaineASigner, signer, verifier } from "./signature.ts";

const SECRET = "TEST-NE-PAS-UTILISER-cle-c1-console-a";
const T = 1792800000;
const corps = Buffer.from('{"a":1}');

describe("signature HTTP commune", () => {
  it("[LOT0-c1] la chaîne signée porte version, horodatage, méthode, chemin et empreinte du corps", () => {
    const empreinte = createHash("sha256").update(corps).digest("hex");
    expect(chaineASigner(String(T), "POST", "/api/console/v1/devis", corps)).toBe(`v1\n${T}\nPOST\n/api/console/v1/devis\n${empreinte}`);
  });

  it("[LOT0-c1] une signature correcte est acceptée, à l'octet près", () => {
    const s = signer(SECRET, String(T), "POST", "/api/console/v1/devis", corps);
    expect(s).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifier(SECRET, String(T), "POST", "/api/console/v1/devis", corps, s, T)).toEqual({ ok: true });
    const autre = Buffer.from('{ "a": 1 }');
    expect(verifier(SECRET, String(T), "POST", "/api/console/v1/devis", autre, s, T).ok).toBe(false);
  });

  it("[LOT0-c1] un corps rejoué vers un autre chemin est refusé", () => {
    const s = signer(SECRET, String(T), "POST", "/api/console/v1/devis", corps);
    expect(verifier(SECRET, String(T), "POST", "/api/console/v1/plans-recurrents", corps, s, T)).toEqual({ ok: false, code: "signature_invalide" });
    expect(verifier(SECRET, String(T), "GET", "/api/console/v1/devis", corps, s, T)).toEqual({ ok: false, code: "signature_invalide" });
  });

  it("[LOT0-c1] horodatage de 300 s accepté, de 301 s refusé", () => {
    const s = signer(SECRET, String(T), "POST", "/p", corps);
    expect(verifier(SECRET, String(T), "POST", "/p", corps, s, T + 300).ok).toBe(true);
    expect(verifier(SECRET, String(T), "POST", "/p", corps, s, T + 301)).toEqual({ ok: false, code: "horodatage_perime" });
    expect(verifier(SECRET, String(T), "POST", "/p", corps, s, T - 301)).toEqual({ ok: false, code: "horodatage_perime" });
  });

  it("[LOT0-c1] horodatage de 9 ou 11 chiffres refusé", () => {
    for (const h of ["179280000", "17928000000", "abcdefghij"]) {
      const s = signer(SECRET, h, "POST", "/p", corps);
      expect(verifier(SECRET, h, "POST", "/p", corps, s, T).ok).toBe(false);
    }
  });

  it("[LOT0-c1] une mauvaise clé ou une signature mal formée est refusée ; deux clés actives acceptées", () => {
    const s = signer(SECRET, String(T), "POST", "/p", corps);
    expect(verifier("TEST-NE-PAS-UTILISER-autre", String(T), "POST", "/p", corps, s, T).ok).toBe(false);
    expect(verifier(SECRET, String(T), "POST", "/p", corps, "v1=zz", T).ok).toBe(false);
    expect(verifier(["TEST-NE-PAS-UTILISER-autre", SECRET], String(T), "POST", "/p", corps, s, T).ok).toBe(true);
  });
});
