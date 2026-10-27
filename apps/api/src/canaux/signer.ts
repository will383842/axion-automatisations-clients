import { randomUUID } from "node:crypto";
import { EN_TETES, signer } from "../../../../packages/contrats/src/commun/signature.js";
import type { CleEchange, Sens } from "../coffre/cles-echanges.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { journaliser, type Canal, type Journal } from "./journal-canal.js";

// Signature des requêtes sortantes (C1 console → Hub, C3 console → CRM) : un secret par sens, ici le sens « emission ».
// Le calcul est celui de packages/contrats ; ce fichier ne choisit que la clé. Le secret passe en base64 (texte ASCII).
const CACHE_SECONDES = 300;

export interface SourceCles {
  cleActive(canal: string, sens: Sens): Promise<CleEchange>;
}
export interface OptionsSigneur {
  cles: SourceCles;
  actif: (canal: Canal) => boolean;
  journal?: Journal;
}

export function creerSigneur({ cles, actif, journal }: OptionsSigneur) {
  const memoire = new Map<Canal, { cle: CleEchange; lueA: number }>();

  async function cleDe(canal: Canal, maintenant: number): Promise<CleEchange> {
    const vue = memoire.get(canal);
    if (vue && maintenant >= vue.lueA && maintenant - vue.lueA < CACHE_SECONDES) return vue.cle;
    const cle = await cles.cleActive(canal, "emission");
    memoire.set(canal, { cle, lueA: maintenant });
    return cle;
  }

  return {
    // `chemin` : tel qu'envoyé, requête comprise, sans normalisation. `maintenant` : secondes Unix.
    // Chaque nouvel essai se re-signe avec un nouvel horodatage (sinon l'anti-rejeu le refuse).
    async signerRequete(canal: Canal, methode: string, chemin: string, corps: Uint8Array | string, maintenant: number): Promise<Record<string, string>> {
      const horodatage = String(Math.floor(maintenant));
      const sortie = (resultat: string, cle?: string) => journaliser(journal, { canal, sens: "sortant", route: chemin, cle, horodatage, resultat, id_trace: randomUUID() });
      if (!actif(canal)) {
        sortie("porte_fermee");
        throw new ErreurApi("porte_fermee", "Canal fermé.");
      }
      if (!/^[0-9]{10}$/.test(horodatage)) throw new Error("horodatage invalide");
      const cle = await cleDe(canal, maintenant);
      const signature = signer(cle.secret.toString("base64"), horodatage, methode, chemin, corps);
      sortie("ok", cle.kid);
      return { [EN_TETES.cle]: cle.kid, [EN_TETES.horodatage]: horodatage, [EN_TETES.signature]: signature };
    },
  };
}
