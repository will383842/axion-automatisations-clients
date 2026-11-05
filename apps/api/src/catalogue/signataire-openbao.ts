import { chaineASigner, empreinteArtefact, FICHIER_SIGNATURE, type Artefact, type SignatureArtefact } from "../../../../packages/sdk-module/src/emballage/signer.ts";
import { appeler, ErreurCoffre, type OptionsBao } from "../coffre/coffre.js";

// Signature des modules par le moteur transit d'OpenBao (T4-26) : la clé Ed25519 est non exportable, la console envoie une chaîne à signer et reçoit une signature.
// Deux clés séparées : « modules-recette » (entrée en recette) et « modules-publication » (passage à « publiée »). Le jeton de publication n'a que la politique « publication » (sign/modules-publication) ; celui de la recette est hors de cette fiche.
// Aucun repli sur une clé locale : si le coffre est scellé ou injoignable, rien n'est signé.
// Écart assumé : l'interface `Signataire` du SDK (T4-07) est synchrone ; un appel au coffre est asynchrone, d'où `signerArtefact` propre à ce fichier (le SDK n'est pas dans la fiche).
export type CleSignature = "modules-recette" | "modules-publication";
const CLES: ReadonlySet<string> = new Set<CleSignature>(["modules-recette", "modules-publication"]);
const EMPREINTE = /^[0-9a-f]{64}$/;
// « vault:v<n>:<base64> » : une version de clé à partir de 1, puis exactement 64 octets (signature Ed25519).
const FORME_SIGNATURE = /^vault:v([1-9]\d{0,5}):([A-Za-z0-9+/]{86}==)$/;
const indisponible = () => new ErreurCoffre("coffre_indisponible");

export function creerSignataireOpenBao(o: OptionsBao, cle: CleSignature) {
  if (!CLES.has(cle)) throw new Error("clé de signature inconnue");
  return {
    // La console ne fait signer qu'une empreinte SHA-256 : le préfixe de domaine est ajouté ici, jamais fourni par l'appelant.
    async signer(empreinte: string): Promise<{ idCle: string; signature: string }> {
      if (typeof empreinte !== "string" || !EMPREINTE.test(empreinte)) throw new ErreurCoffre("requete_refusee");
      const reponse = (await appeler(o, "POST", `transit/sign/${cle}`, { input: Buffer.from(chaineASigner(empreinte)).toString("base64") })) as { data?: { signature?: unknown } } | undefined;
      const brute = reponse?.data?.signature;
      const m = typeof brute === "string" ? FORME_SIGNATURE.exec(brute) : null;
      if (!m || Buffer.from(m[2] ?? "", "base64").length !== 64) throw indisponible();
      return { idCle: `${cle}:v${m[1]}`, signature: m[2] ?? "" };
    },
    // L'empreinte est recalculée ici depuis les fichiers : on ne signe jamais l'empreinte d'un autre artefact.
    async signerArtefact(fichiers: Artefact): Promise<Artefact> {
      const empreinte = empreinteArtefact(fichiers);
      const { idCle, signature } = await this.signer(empreinte);
      const contenu: SignatureArtefact = { v: 1, algo: "ed25519", idCle, empreinte, signature };
      return { ...fichiers, [FICHIER_SIGNATURE]: new TextEncoder().encode(JSON.stringify(contenu)) };
    },
  };
}
