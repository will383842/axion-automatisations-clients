import { createPublicKey, verify } from "node:crypto";
import { type ClePublique } from "./cles-publiques.js";
import { FICHIER_SIGNATURE, chaineASigner, empreinteArtefact, type Artefact } from "./signer.js";

export type ResultatVerification = { ok: true; fichiers: Artefact } | { ok: false; code: "module_non_signe" };

const REFUS: ResultatVerification = { ok: false, code: "module_non_signe" };

// Vérifie sur une COPIE des octets (chaque fichier lu une seule fois) et la rend :
// l'appelant charge depuis cette copie, jamais depuis une relecture (TOCTOU).
export function verifierArtefact(artefact: Artefact, clesPubliques: readonly ClePublique[]): ResultatVerification {
  try {
    const fichiers: Artefact = {};
    for (const chemin of Object.keys(artefact)) fichiers[chemin] = Uint8Array.from(artefact[chemin] as Uint8Array);
    const brut = fichiers[FICHIER_SIGNATURE];
    if (brut === undefined) return REFUS;
    const s: unknown = JSON.parse(new TextDecoder().decode(brut));
    if (typeof s !== "object" || s === null) return REFUS;
    const { v, algo, idCle, empreinte, signature } = s as Record<string, unknown>;
    if (v !== 1 || algo !== "ed25519") return REFUS;
    if (typeof idCle !== "string" || typeof empreinte !== "string" || typeof signature !== "string") return REFUS;
    if (empreinte !== empreinteArtefact(fichiers)) return REFUS;
    const cle = clesPubliques.find((c) => c.idCle === idCle);
    if (cle === undefined || cle.revoquee === true) return REFUS;
    const valide = verify(null, Buffer.from(chaineASigner(empreinte)), createPublicKey(cle.publique), Buffer.from(signature, "base64"));
    return valide ? { ok: true, fichiers } : REFUS;
  } catch {
    return REFUS;
  }
}
