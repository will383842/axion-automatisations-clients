import { createHash } from "node:crypto";
import type { IdentifiantsS3, PortS3 } from "./stockage.js";

// Artefacts signés (A-061) : la clé EST l'empreinte SHA-256 du contenu, dans le compartiment commun « artefacts ».
// Immuable : on n'écrase jamais un objet existant, et on relit en revérifiant l'empreinte.

export type CodeArtefact = "artefact_vide" | "empreinte_invalide" | "empreinte_occupee" | "empreinte_incorrecte" | "introuvable";

export class ErreurArtefact extends Error {
  constructor(readonly code: CodeArtefact) {
    super(code);
    this.name = "ErreurArtefact";
  }
}

const COMPARTIMENT = "artefacts";
const EMPREINTE = /^[0-9a-f]{64}$/;
const sha256 = (o: Uint8Array) => createHash("sha256").update(o).digest("hex");

export function creerArtefacts(o: { s3: PortS3; identifiants: IdentifiantsS3 }) {
  return {
    async deposerArtefact(octets: Uint8Array): Promise<string> {
      if (octets.length === 0) throw new ErreurArtefact("artefact_vide");
      const empreinte = sha256(octets);
      const existant = await o.s3.lire(o.identifiants, COMPARTIMENT, empreinte);
      if (existant) {
        if (sha256(existant) !== empreinte) throw new ErreurArtefact("empreinte_occupee");
        return empreinte;
      }
      await o.s3.deposer(o.identifiants, COMPARTIMENT, empreinte, octets);
      return empreinte;
    },
    async lireArtefact(empreinte: string): Promise<Uint8Array> {
      if (typeof empreinte !== "string" || !EMPREINTE.test(empreinte)) throw new ErreurArtefact("empreinte_invalide");
      const octets = await o.s3.lire(o.identifiants, COMPARTIMENT, empreinte);
      if (!octets) throw new ErreurArtefact("introuvable");
      if (sha256(octets) !== empreinte) throw new ErreurArtefact("empreinte_incorrecte");
      return octets;
    },
  };
}
