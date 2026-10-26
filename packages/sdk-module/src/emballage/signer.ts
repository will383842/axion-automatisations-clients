import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

// Un artefact = ses fichiers en mémoire (chemin → octets), signature.json compris.
export type Artefact = Record<string, Uint8Array>;
export type SignatureArtefact = { v: 1; algo: "ed25519"; idCle: string; empreinte: string; signature: string };

export interface Signataire {
  signer(empreinte: string): { idCle: string; signature: string };
}

export const FICHIER_SIGNATURE = "signature.json";

// Préfixe de domaine : une signature d'autre chose ne vaut pas pour un module.
export function chaineASigner(empreinte: string): string {
  return `axion-module\nv1\n${empreinte}`;
}

// Seuls les chemins relatifs simples désignent un fichier : sans \0, saut de ligne, \, segment vide, . ou .. ni __proto__.
// Ainsi un chemin ne peut pas imiter plusieurs lignes de l'empreinte, ni toucher le prototype d'une copie.
export function cheminValide(chemin: string): boolean {
  if (chemin === "" || /[\0\r\n\\]/.test(chemin)) return false;
  return chemin.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== "__proto__");
}

// Empreinte de tous les fichiers sauf signature.json, dans l'ordre des chemins.
export function empreinteArtefact(fichiers: Artefact): string {
  const chemins = Object.keys(fichiers);
  if (!chemins.every(cheminValide)) throw new Error("chemin d'artefact invalide");
  const lignes = chemins
    .filter((chemin) => chemin !== FICHIER_SIGNATURE)
    .sort()
    .map((chemin) => `${chemin}\0${createHash("sha256").update(fichiers[chemin] as Uint8Array).digest("hex")}\n`);
  return createHash("sha256").update(lignes.join("")).digest("hex");
}

// Clé de TEST générée à la construction. La clé de production vit dans le coffre (T4-26).
export class SignataireMemoire implements Signataire {
  readonly clePublique: string;
  readonly #privee: KeyObject;

  constructor(private readonly idCle: string) {
    if (process.env["NODE_ENV"] === "production") throw new Error("SignataireMemoire est réservé aux tests");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.#privee = privateKey;
    this.clePublique = publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  signer(empreinte: string): { idCle: string; signature: string } {
    return { idCle: this.idCle, signature: sign(null, Buffer.from(chaineASigner(empreinte)), this.#privee).toString("base64") };
  }
}

export function signerArtefact(fichiers: Artefact, signataire: Signataire): Artefact {
  const empreinte = empreinteArtefact(fichiers);
  const { idCle, signature } = signataire.signer(empreinte);
  const contenu: SignatureArtefact = { v: 1, algo: "ed25519", idCle, empreinte, signature };
  return { ...fichiers, [FICHIER_SIGNATURE]: new TextEncoder().encode(JSON.stringify(contenu)) };
}
