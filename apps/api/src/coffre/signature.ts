import { appeler, ErreurCoffre, type OptionsBao } from "./coffre.js";

// Signature des modules (A-193) : clé transit « modules-signature », Ed25519, non exportable.
// La clé privée ne sort jamais d'OpenBao : on envoie les octets à signer, on reçoit la signature. Aucun appel d'export dans ce fichier.
// Pas de copie transit (OpenBao la refuse pour une clé non exportable) : le secours (A-303) est un instantané raft, hors de l'application (ADR 0017).

const CLE = "modules-signature";
const FORME_SIGNATURE = /^vault:v\d+:[A-Za-z0-9+/]+={0,2}$/;
const indisponible = () => new ErreurCoffre("coffre_indisponible");
const donnees = (reponse: unknown): Record<string, unknown> => {
  const d = (reponse as { data?: unknown } | undefined)?.data;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
};

export function creerSignature(o: OptionsBao) {
  return {
    // Appelée à l'initialisation (jeton racine) : initialiser.sh crée la même clé avec les mêmes réglages.
    async creerCle(): Promise<void> {
      await appeler(o, "POST", `transit/keys/${CLE}`, { type: "ed25519", exportable: false });
    },
    async etatCle(): Promise<{ type: string; exportable: false; sauvegardeEnClair: false }> {
      const d = donnees(await appeler(o, "GET", `transit/keys/${CLE}`));
      if (d.type !== "ed25519" || d.exportable !== false || d.allow_plaintext_backup === true) throw indisponible();
      return { type: "ed25519", exportable: false, sauvegardeEnClair: false };
    },
    async signer(octets: Buffer): Promise<string> {
      const signature = donnees(await appeler(o, "POST", `transit/sign/${CLE}`, { input: octets.toString("base64") })).signature;
      if (typeof signature !== "string" || !FORME_SIGNATURE.test(signature)) throw indisponible();
      return signature;
    },
    async verifier(octets: Buffer, signature: string): Promise<boolean> {
      if (typeof signature !== "string" || !FORME_SIGNATURE.test(signature)) return false;
      const valide = donnees(await appeler(o, "POST", `transit/verify/${CLE}`, { input: octets.toString("base64"), signature })).valid;
      if (typeof valide !== "boolean") throw indisponible();
      return valide;
    },
  };
}
