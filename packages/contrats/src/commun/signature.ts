import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Signature HTTP commune à C1, C2, C3 et C4 (clé par cellule pour C4).
// C6 n'est pas une requête HTTP : jeton HMAC propre (T0-16), qui reprend seulement
// la règle des 2 clés et la comparaison en temps constant.
export const EN_TETES = { cle: "X-Axion-Cle", horodatage: "X-Axion-Horodatage", signature: "X-Axion-Signature" } as const;
export const FENETRE_SECONDES = 300;

export type ResultatVerification = { ok: true } | { ok: false; code: "signature_invalide" | "horodatage_perime" };

const HORODATAGE = /^[0-9]{10}$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;

// Le corps est haché tel qu'envoyé (octets), jamais après une ré-sérialisation JSON.
export function chaineASigner(horodatage: string, methode: string, chemin: string, corps: Uint8Array | string): string {
  const empreinte = createHash("sha256").update(corps).digest("hex");
  return `v1\n${horodatage}\n${methode}\n${chemin}\n${empreinte}`;
}

export function signer(secret: string, horodatage: string, methode: string, chemin: string, corps: Uint8Array | string): string {
  return `v1=${createHmac("sha256", secret).update(chaineASigner(horodatage, methode, chemin, corps)).digest("hex")}`;
}

// `secrets` : les 2 clés actives d'un sens (chevauchement de rotation). `maintenant` : secondes Unix.
export function verifier(
  secrets: string | readonly string[],
  horodatage: string,
  methode: string,
  chemin: string,
  corps: Uint8Array | string,
  signature: string,
  maintenant: number,
): ResultatVerification {
  const refus = { ok: false, code: "signature_invalide" } as const;
  const recu = SIGNATURE.exec(signature)?.[1];
  // Le séparateur \n ne doit apparaître ni dans la méthode ni dans le chemin : découpe non ambiguë.
  if (!recu || !HORODATAGE.test(horodatage) || /\n/.test(methode + chemin)) return refus;
  let valide = false;
  for (const secret of typeof secrets === "string" ? [secrets] : secrets) {
    const attendu = signer(secret, horodatage, methode, chemin, corps).slice(3);
    if (timingSafeEqual(Buffer.from(attendu, "hex"), Buffer.from(recu, "hex"))) valide = true;
  }
  if (!valide) return refus;
  return Math.abs(maintenant - Number(horodatage)) > FENETRE_SECONDES ? { ok: false, code: "horodatage_perime" } : { ok: true };
}
