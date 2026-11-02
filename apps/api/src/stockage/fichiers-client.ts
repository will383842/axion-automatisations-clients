import { contexteFichier, delierContexte, formatChamp, lireEnveloppeChamp, serialiserEnveloppe } from "../donnees/colonnes-chiffrees.js";
import type { creerEnveloppe } from "../coffre/enveloppe.js";

// Fichiers du compartiment cli-<id> chiffrés par enveloppe avec la clé du client (A-201, A-244), même clé que les colonnes.
// Le stockage (T1A-11) ne reçoit que le chiffré. La version de clé et la clé de données CHIFFRÉE sont dans l'en-tête de l'objet
// (le port de dépôt n'a pas de métadonnée d'objet) ; la clé de données en clair n'est jamais écrite.
// Sans clé du client ou coffre scellé : refus, rien n'est déposé, aucun repli sur une autre clé.

export interface PortFichiers {
  deposer(tenantId: string, cle: string, octets: Uint8Array): Promise<void>;
  lire(tenantId: string, cle: string): Promise<Uint8Array | undefined>;
}

export function creerFichiersClient(o: { stockage: PortFichiers; enveloppe: Pick<ReturnType<typeof creerEnveloppe>, "chiffrer" | "dechiffrer"> }) {
  return {
    async deposerFichier(tenantId: string, cle: string, octets: Uint8Array): Promise<void> {
      // Le contexte « fichier:<cle> » est dans les données associées (AAD) : un objet déplacé sous une autre clé, ou un champ, ne se lit pas.
      await o.stockage.deposer(tenantId, cle, serialiserEnveloppe(await o.enveloppe.chiffrer(tenantId, Buffer.from(octets), contexteFichier(cle))));
    },
    async lireFichier(tenantId: string, cle: string): Promise<Buffer | undefined> {
      const brut = await o.stockage.lire(tenantId, cle);
      if (brut === undefined) return undefined;
      const attendu = contexteFichier(cle);
      const e = lireEnveloppeChamp(brut);
      // Format 1 (anciens objets de T2-33) : contexte en tête du clair, lu pendant la transition tant que le balayage n'est pas passé.
      return formatChamp(brut) === 2 ? o.enveloppe.dechiffrer(tenantId, e, attendu) : delierContexte(attendu, await o.enveloppe.dechiffrer(tenantId, e));
    },
  };
}
