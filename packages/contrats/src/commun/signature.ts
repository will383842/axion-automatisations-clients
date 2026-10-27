import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Signature HTTP commune à C1, C2, C3 et C4 (clé par cellule pour C4).
// C6 n'est pas une requête HTTP : jeton HMAC propre (T0-16), qui reprend seulement
// la règle des 2 clés et la comparaison en temps constant.
export const EN_TETES = {
  cle: "X-Axion-Cle",
  horodatage: "X-Axion-Horodatage",
  signature: "X-Axion-Signature",
  idempotence: "Idempotency-Key",
  rejoue: "Idempotency-Replayed",
  reessayerApres: "Retry-After",
} as const;
export const FENETRE_SECONDES = 300;
// Anti-rejeu : le couple (clé, signature) est gardé 10 min, plus que la fenêtre de ±300 s.
export const ANTI_REJEU_SECONDES = 600;
// Idempotency-Key : la réponse est gardée 30 jours au moins.
export const CONSERVATION_IDEMPOTENCE_JOURS = 30;

// Une clé active d'un sens : `id` est la valeur de X-Axion-Cle (C4 : `c4:<celluleId>:<n>`).
export type CleSignature = { id: string; secret: string };
export type RequeteSignee = {
  cle: string;
  horodatage: string;
  methode: string;
  chemin: string;
  corps: Uint8Array | string;
  signature: string;
};
// `cle` : identifiant de la clé qui a validé ; l'appelant en déduit le sens ou la cellule (C4).
export type ResultatVerification = { ok: true; cle: string } | { ok: false; code: "signature_invalide" | "horodatage_perime" | "rejeu" };

const HORODATAGE = /^[0-9]{10}$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;
const refus = { ok: false, code: "signature_invalide" } as const;

// Le corps est haché tel qu'envoyé (octets), jamais après une ré-sérialisation JSON.
export function chaineASigner(horodatage: string, methode: string, chemin: string, corps: Uint8Array | string): string {
  const empreinte = createHash("sha256").update(corps).digest("hex");
  return `v1\n${horodatage}\n${methode}\n${chemin}\n${empreinte}`;
}

export function signer(secret: string, horodatage: string, methode: string, chemin: string, corps: Uint8Array | string): string {
  return `v1=${createHmac("sha256", secret).update(chaineASigner(horodatage, methode, chemin, corps)).digest("hex")}`;
}

// `cles` : les clés actives du sens (2 pendant une rotation) ; le secret est choisi par l'identifiant reçu.
// `maintenant` : secondes Unix.
// `dejaVu(cle, signature)` : vrai si le couple a déjà été vu dans les ANTI_REJEU_SECONDES ; sinon il le garde.
// Il n'est appelé qu'après une signature valide dans la fenêtre : une requête falsifiée ne remplit pas la mémoire.
// Toute exception (entrée inattendue, panne de dejaVu) est un refus : le contrôle échoue fermé.
export function verifier(
  cles: readonly CleSignature[],
  requete: RequeteSignee,
  maintenant: number,
  dejaVu: (cle: string, signature: string) => boolean,
): ResultatVerification {
  try {
    return controler(cles, requete, maintenant, dejaVu);
  } catch {
    return refus;
  }
}

function controler(
  cles: readonly CleSignature[],
  { cle, horodatage, methode, chemin, corps, signature }: RequeteSignee,
  maintenant: number,
  dejaVu: (cle: string, signature: string) => boolean,
): ResultatVerification {
  const recu = SIGNATURE.exec(signature)?.[1];
  // Le séparateur \n ne doit apparaître ni dans la méthode ni dans le chemin : découpe non ambiguë.
  if (!recu || !HORODATAGE.test(horodatage) || /\n/.test(methode + chemin) || !Number.isSafeInteger(maintenant)) return refus;
  const active = cles.find((c) => c.id === cle);
  if (!active) return refus;
  const attendu = signer(active.secret, horodatage, methode, chemin, corps).slice(3);
  if (!timingSafeEqual(Buffer.from(attendu, "hex"), Buffer.from(recu, "hex"))) return refus;
  if (Math.abs(maintenant - Number(horodatage)) > FENETRE_SECONDES) return { ok: false, code: "horodatage_perime" };
  if (dejaVu(active.id, signature)) return { ok: false, code: "rejeu" };
  return { ok: true, cle: active.id };
}
