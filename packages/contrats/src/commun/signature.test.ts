import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANTI_REJEU_SECONDES, CONSERVATION_IDEMPOTENCE_JOURS, EN_TETES, chaineASigner, signer, verifier, type RequeteSignee } from "./signature.ts";

const SECRET = "TEST-NE-PAS-UTILISER-cle-c1-console-a";
const AUTRE = "TEST-NE-PAS-UTILISER-autre";
const CLE = "cle-test-c1-console-a";
const T = 1792800000;
const corps = Buffer.from('{"a":1}');
const cles = [{ id: CLE, secret: SECRET }];
const jamais = () => false;

// Requête signée par la clé de test ; les champs passés remplacent ceux de la requête signée.
const requete = (chemin = "/api/console/v1/devis", changement: Partial<RequeteSignee> = {}, methode = "POST"): RequeteSignee => ({
  cle: CLE, horodatage: String(T), methode, chemin, corps, signature: signer(SECRET, String(T), methode, chemin, corps), ...changement,
});

describe("signature HTTP commune", () => {
  it("[LOT0-c1] la chaîne signée porte version, horodatage, méthode, chemin et empreinte du corps", () => {
    const empreinte = createHash("sha256").update(corps).digest("hex");
    expect(chaineASigner(String(T), "POST", "/api/console/v1/devis", corps)).toBe(`v1\n${T}\nPOST\n/api/console/v1/devis\n${empreinte}`);
  });

  it("[LOT0-c1] une signature correcte est acceptée, à l'octet près, et la clé qui a validé est rendue", () => {
    const r = requete();
    expect(r.signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifier(cles, r, T, jamais)).toEqual({ ok: true, cle: CLE });
    expect(verifier(cles, { ...r, corps: Buffer.from('{ "a": 1 }') }, T, jamais).ok).toBe(false);
  });

  it("[LOT0-c1] un corps rejoué vers un autre chemin est refusé", () => {
    const r = requete();
    expect(verifier(cles, { ...r, chemin: "/api/console/v1/plans-recurrents" }, T, jamais)).toEqual({ ok: false, code: "signature_invalide" });
    expect(verifier(cles, { ...r, methode: "GET" }, T, jamais)).toEqual({ ok: false, code: "signature_invalide" });
  });

  it("[LOT0-c1] horodatage de 300 s accepté, de 301 s refusé", () => {
    const r = requete("/p");
    expect(verifier(cles, r, T + 300, jamais).ok).toBe(true);
    expect(verifier(cles, r, T + 301, jamais)).toEqual({ ok: false, code: "horodatage_perime" });
    expect(verifier(cles, r, T - 301, jamais)).toEqual({ ok: false, code: "horodatage_perime" });
  });

  it("[LOT0-c1] horodatage de 9 ou 11 chiffres refusé", () => {
    for (const h of ["179280000", "17928000000", "abcdefghij"]) {
      expect(verifier(cles, { ...requete("/p"), horodatage: h, signature: signer(SECRET, h, "POST", "/p", corps) }, T, jamais).ok).toBe(false);
    }
  });

  it("[LOT0-c1] une mauvaise clé ou une signature mal formée est refusée ; deux clés actives acceptées", () => {
    const r = requete("/p");
    expect(verifier([{ id: CLE, secret: AUTRE }], r, T, jamais).ok).toBe(false);
    expect(verifier(cles, { ...r, signature: "v1=zz" }, T, jamais).ok).toBe(false);
    const rotation = [{ id: "cle-test-c1-console-b", secret: AUTRE }, ...cles];
    expect(verifier(rotation, r, T, jamais)).toEqual({ ok: true, cle: CLE });
    const nouvelle = { ...r, cle: "cle-test-c1-console-b", signature: signer(AUTRE, String(T), "POST", "/p", corps) };
    expect(verifier(rotation, nouvelle, T, jamais)).toEqual({ ok: true, cle: "cle-test-c1-console-b" });
  });

  it("[LOT0-c1] le secret est choisi par l'identifiant X-Axion-Cle : identifiant inconnu ou d'une autre clé refusé", () => {
    const rotation = [{ id: "cle-test-c1-console-b", secret: AUTRE }, ...cles];
    expect(verifier(rotation, { ...requete("/p"), cle: "cle-inconnue" }, T, jamais)).toEqual({ ok: false, code: "signature_invalide" });
    // Signée par la clé A mais annoncée comme la clé B : refusée, même si A est active.
    expect(verifier(rotation, { ...requete("/p"), cle: "cle-test-c1-console-b" }, T, jamais)).toEqual({ ok: false, code: "signature_invalide" });
  });

  it("[LOT0-c1] la même requête signée rejouée est refusée en 401 rejeu", () => {
    const vus = new Set<string>();
    const dejaVu = (cle: string, signature: string) => {
      const k = `${cle} ${signature}`;
      if (vus.has(k)) return true;
      vus.add(k);
      return false;
    };
    const r = requete();
    expect(verifier(cles, r, T, dejaVu)).toEqual({ ok: true, cle: CLE });
    expect(verifier(cles, r, T + 1, dejaVu)).toEqual({ ok: false, code: "rejeu" });
    // Nouvel essai re-signé (nouvel horodatage) : accepté, l'Idempotency-Key fait le reste.
    const resigne = { ...r, horodatage: String(T + 2), signature: signer(SECRET, String(T + 2), "POST", r.chemin, corps) };
    expect(verifier(cles, resigne, T + 2, dejaVu).ok).toBe(true);
  });

  it("[LOT0-c1] dejaVu n'est appelé qu'après une signature valide dans la fenêtre ; sa panne est un refus", () => {
    const appels: string[] = [];
    const note = (cle: string, signature: string) => (appels.push(`${cle} ${signature}`), false);
    verifier(cles, { ...requete(), signature: `v1=${"0".repeat(64)}` }, T, note);
    verifier(cles, requete(), T + 400, note);
    expect(appels).toEqual([]);
    expect(verifier(cles, requete(), T, () => { throw new Error("mémoire injoignable"); })).toEqual({ ok: false, code: "signature_invalide" });
  });

  it("[LOT0-c1] en-têtes et durées de l'anti-doublon nommés dans le contrat", () => {
    expect(EN_TETES).toMatchObject({ idempotence: "Idempotency-Key", rejoue: "Idempotency-Replayed", reessayerApres: "Retry-After" });
    expect(ANTI_REJEU_SECONDES).toBe(600);
    expect(CONSERVATION_IDEMPOTENCE_JOURS).toBe(30);
  });
});
