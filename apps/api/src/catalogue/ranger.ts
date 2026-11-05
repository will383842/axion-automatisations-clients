import type { IdentifiantsS3, PortS3 } from "../stockage/stockage.js";
import { cheminValide, type Artefact } from "../../../../packages/sdk-module/src/emballage/signer.ts";

// Rangement adressé par empreinte (A-304, A-407) : modules/<empreinte>/<fichier> dans le compartiment dédié aux modules.
// Écriture unique : le code n'appelle QUE deposerSiAbsent (jamais deposer) ; la brique refuse en plus tout écrasement par une politique du compartiment (T1A-11).
// Pas de suppression : le port n'en offre pas pour les objets. Un objet déjà en place doit avoir exactement les mêmes octets, sinon c'est une erreur.
export type CodeRangement = "identifiants_etrangers" | "empreinte_invalide" | "empreinte_occupee" | "introuvable";
export class ErreurRangement extends Error {
  constructor(readonly code: CodeRangement) {
    super(code);
    this.name = "ErreurRangement";
  }
}

const COMPARTIMENT = "modules";
const EMPREINTE = /^[0-9a-f]{64}$/;
const egal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

export function creerRangement(o: { s3: PortS3; identifiants: IdentifiantsS3 }) {
  if (o.identifiants.compartiment !== COMPARTIMENT) throw new ErreurRangement("identifiants_etrangers");
  const prefixe = (empreinte: string) => {
    if (typeof empreinte !== "string" || !EMPREINTE.test(empreinte)) throw new ErreurRangement("empreinte_invalide");
    return `modules/${empreinte}/`;
  };
  return {
    // Reprise sûre : si un rangement précédent s'est arrêté au milieu, les fichiers manquants se complètent, les présents sont comparés.
    async ranger(empreinte: string, fichiers: Artefact): Promise<string> {
      const base = prefixe(empreinte);
      for (const [nom, octets] of Object.entries(fichiers)) {
        if (!cheminValide(nom)) throw new ErreurRangement("empreinte_invalide");
        if (await o.s3.deposerSiAbsent(o.identifiants, COMPARTIMENT, `${base}${nom}`, octets)) continue;
        const existant = await o.s3.lire(o.identifiants, COMPARTIMENT, `${base}${nom}`);
        if (!existant || !egal(existant, octets)) throw new ErreurRangement("empreinte_occupee");
      }
      return base;
    },
    async lire(empreinte: string): Promise<Artefact> {
      const base = prefixe(empreinte);
      const rendu: Artefact = Object.create(null) as Artefact;
      for (const nom of ["module.js", "manifest.json", "sbom.cdx.json", "signature.json", "empreinte.sha256"]) {
        const octets = await o.s3.lire(o.identifiants, COMPARTIMENT, `${base}${nom}`);
        if (octets) rendu[nom] = octets;
      }
      if (!rendu["manifest.json"]) throw new ErreurRangement("introuvable");
      return rendu;
    },
  };
}
