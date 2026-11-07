import { createHash, randomBytes } from "node:crypto";

// Parcours OAuth en cours (PKCE, state, nonce). En mémoire, un seul processus : un redémarrage perd les parcours et la personne recommence.
export type CodeConnexion =
  | "lien_invalide" | "porte_fermee" | "outil_non_oauth" | "etat_inconnu" | "autre_session" | "transaction_echue"
  | "accord_admin_requis" | "mauvais_compte" | "refus_fournisseur" | "fournisseur_indisponible" | "pkce_absent"
  | "application_inconnue" | "deja_utilise" | "ecriture_echouee";

export class ErreurConnexion extends Error {
  constructor(readonly code: CodeConnexion) { super(code); }
}

export interface NouvelleTransaction {
  sujet: string;
  tenantId: string;
  connexionId: string;
  outil: string;
  fournisseur: "microsoft" | "google";
  genre: "autorisation" | "accord_admin";
  locataire?: string;
  domaine?: string;
}
export interface Transaction extends NouvelleTransaction { state: string; verifier: string; nonce: string; echeance: number }

export interface TransactionsOAuth {
  creer(t: NouvelleTransaction): Promise<Transaction>;
  // Retire l'entrée : usage unique, un rejeu ne retrouve rien.
  prendre(state: string): Promise<Transaction | null>;
  taille(): number;
}

export const ECHEANCE_MS = 10 * 60_000;
export const MAX_EN_VOL = 1000;
export const defiPkce = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

export function creerTransactionsMemoire(o: { maintenant: () => number; aleatoire?: (n: number) => Uint8Array }): TransactionsOAuth {
  const alea = o.aleatoire ?? ((n: number) => randomBytes(n));
  const b64 = () => Buffer.from(alea(32)).toString("base64url");
  const en_vol = new Map<string, Transaction>();
  return {
    async creer(t) {
      const tx: Transaction = { ...t, state: b64(), verifier: b64(), nonce: b64(), echeance: o.maintenant() + ECHEANCE_MS };
      // Jamais de valeur dans une chaîne ou un JSON de journal.
      for (const nom of ["toString", "toJSON"]) Object.defineProperty(tx, nom, { value: () => "[transaction]", enumerable: false });
      en_vol.set(tx.state, tx);
      while (en_vol.size > MAX_EN_VOL) en_vol.delete(en_vol.keys().next().value as string);
      return tx;
    },
    async prendre(state) {
      const tx = en_vol.get(state) ?? null;
      en_vol.delete(state);
      return tx;
    },
    taille: () => en_vol.size,
  };
}
