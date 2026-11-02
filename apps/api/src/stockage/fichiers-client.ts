import { contexteFichier, delierContexte, lierContexte, lireEnveloppeChamp, serialiserEnveloppe } from "../donnees/colonnes-chiffrees.js";
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
      // Le clair est précédé de « fichier:<cle> » : un objet déplacé sous une autre clé du compartiment, ou un champ, ne se lit pas.
      const lie = lierContexte(contexteFichier(cle), Buffer.from(octets));
      try {
        await o.stockage.deposer(tenantId, cle, serialiserEnveloppe(await o.enveloppe.chiffrer(tenantId, lie)));
      } finally {
        lie.fill(0);
      }
    },
    async lireFichier(tenantId: string, cle: string): Promise<Buffer | undefined> {
      const brut = await o.stockage.lire(tenantId, cle);
      if (brut === undefined) return undefined;
      const attendu = contexteFichier(cle);
      return delierContexte(attendu, await o.enveloppe.dechiffrer(tenantId, lireEnveloppeChamp(brut)));
    },
  };
}
