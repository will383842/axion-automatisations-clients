import { appeler, ErreurCoffre, type OptionsBao } from "./coffre.js";

// Signature des modules (A-193) et copie de secours (A-303) : clé transit « modules-signature », Ed25519.
// La clé privée ne sort jamais d'OpenBao : on envoie les octets à signer, on reçoit la signature. Aucun appel d'export dans ce fichier.
// La copie de secours (paquet transit) est permise par allow_plaintext_backup, posé à la création et jamais retirable : c'est voulu.
// Le paquet contient la clé : il ne passe ni par un journal ni par une erreur.

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
      await appeler(o, "POST", `transit/keys/${CLE}`, { type: "ed25519", exportable: false, allow_plaintext_backup: true });
    },
    async etatCle(): Promise<{ type: string; exportable: false; sauvegardePossible: true }> {
      const d = donnees(await appeler(o, "GET", `transit/keys/${CLE}`));
      if (d.type !== "ed25519" || d.exportable !== false || d.allow_plaintext_backup !== true) throw indisponible();
      return { type: "ed25519", exportable: false, sauvegardePossible: true };
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
    // À la main par Will (jeton « secours ») : le paquet va dans Bitwarden.
    async exporterSecours(): Promise<Buffer> {
      const paquet = donnees(await appeler(o, "GET", `transit/backup/${CLE}`)).backup;
      if (typeof paquet !== "string" || !paquet) throw indisponible();
      const octets = Buffer.from(paquet, "base64");
      if (octets.toString("base64") !== paquet) throw indisponible();
      return octets;
    },
    // Dans un OpenBao neuf (jeton racine de l'initialisation) : la clé restaurée vérifie les signatures d'avant.
    async restaurerSecours(paquet: Buffer): Promise<void> {
      if (!Buffer.isBuffer(paquet) || paquet.length === 0) throw new ErreurCoffre("requete_refusee");
      await appeler(o, "POST", `transit/restore/${CLE}`, { backup: paquet.toString("base64") });
    },
  };
}
