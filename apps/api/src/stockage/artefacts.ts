import { createHash } from "node:crypto";
import type { IdentifiantsS3, PortS3 } from "./stockage.js";

// Artefacts signés (A-061) : la clé EST l'empreinte SHA-256 du contenu, dans le compartiment commun « artefacts ».
// Immuable : l'écriture est conditionnelle côté brique (jamais d'écrasement) et on relit en revérifiant l'empreinte.
// Pas d'oracle d'existence : même réponse que le contenu soit nouveau ou déjà rangé, et aucune lecture avant l'écriture.
// Les artefacts viennent de la plateforme seule : les identifiants du compartiment ne sont donnés à aucun client.

export type CodeArtefact = "artefact_vide" | "empreinte_invalide" | "empreinte_occupee" | "empreinte_incorrecte" | "introuvable" | "identifiants_etrangers";

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
  if (o.identifiants.compartiment !== COMPARTIMENT) throw new ErreurArtefact("identifiants_etrangers");
  return {
    async deposerArtefact(octets: Uint8Array): Promise<string> {
      if (octets.length === 0) throw new ErreurArtefact("artefact_vide");
      const empreinte = sha256(octets);
      if (!(await o.s3.deposerSiAbsent(o.identifiants, COMPARTIMENT, empreinte, octets))) {
        // Déjà rangé : on vérifie seulement que l'objet en place est bien celui de cette empreinte (jamais d'écrasement).
        const existant = await o.s3.lire(o.identifiants, COMPARTIMENT, empreinte);
        if (!existant || sha256(existant) !== empreinte) throw new ErreurArtefact("empreinte_occupee");
      }
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
