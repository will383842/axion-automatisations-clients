import type { Garantie, PasserelleIa } from "@axion-auto/sdk-module";
import type { Configuration } from "@axion-auto/contrats/src/c4/configuration.ts";
import type { EtatVoulu } from "@axion-auto/contrats/src/c4/etat-voulu.ts";
import type { Evenement } from "@axion-auto/contrats/src/c4/evenements-executeur.ts";

// Tout ce que le noyau touche passe par ces ports : 4B les branche sur PostgreSQL, BullMQ et HTTP.

// Arrêt brutal du processus ou panne d'un port : jamais classé, jamais journalisé, l'exécution reprendra.
export class CoupureProcessus extends Error {}

// Liste fermée : le journal ne garde ni contenu ni texte libre (A-286).
export const CLES_JOURNAL = ["instanceId", "executionId", "etape", "statut", "essai", "a"] as const;
export interface EntreeJournal {
  instanceId: string;
  executionId: string;
  etape: string;
  statut: "faite" | "echec" | "a_trancher";
  essai: number;
  a: string;
}
export interface JournalEtapes {
  inscrire(entree: EntreeJournal): Promise<void>;
  lire(instanceId: string, executionId: string): Promise<readonly EntreeJournal[]>;
}

export interface Intention {
  cle: string;
  instanceId: string;
  executionId: string;
  etape: string;
  element: string;
  action: string;
  garantie: Garantie;
  etat: "ecrite" | "faite" | "a_trancher";
  bail?: Bail;
}
// Un appel en vol tient un bail : tant qu'il est vivant, un autre propriétaire ne rappelle pas l'outil.
export interface Bail {
  proprietaire: string;
  jusqua: number;
}
export interface BoiteEnvoi {
  // Atomique : crée l'intention, ou rend celle qui existe (creee = false). occupee = vrai si un autre propriétaire tient un bail vivant ; sinon le bail est repris.
  ecrire(intention: Omit<Intention, "etat" | "bail">, bail: Bail, maintenant: number): Promise<{ intention: Intention; creee: boolean; occupee: boolean }>;
  lire(cle: string): Promise<Intention | undefined>;
  // Comparer-et-échanger : seulement depuis « ecrite », pour le propriétaire du bail ; rend faux sinon.
  marquerFaite(cle: string, proprietaire: string): Promise<boolean>;
  marquerATrancher(cle: string, proprietaire: string): Promise<boolean>;
  // L'appel est fini sans effet certain : le bail est rendu.
  liberer(cle: string, proprietaire: string): Promise<void>;
}

export type Verification = "trouvee" | "absente" | "inconnue";
export interface Connecteurs {
  appeler(action: string, demande: { cle: string; element: string; entree: unknown; signal: AbortSignal }): Promise<unknown>;
  verifier(action: string, cle: string): Promise<Verification>;
}

export interface Console {
  lireConfiguration(instanceId: string): Promise<Configuration>;
  lireEtatVoulu(instanceId: string): Promise<EtatVoulu>;
  envoyer(evenement: Evenement): Promise<void>;
  mettreEnPause(instanceId: string): Promise<void>;
}

export interface Horloge {
  maintenant(): number;
  attendre(ms: number, signal?: AbortSignal): Promise<void>;
  alea(): number;
}

export interface Ports {
  journal: JournalEtapes;
  boite: BoiteEnvoi;
  connecteurs: Connecteurs;
  console: Console;
  horloge: Horloge;
  // Branchés en 4B : sans passerelle, une étape qui appelle l'IA échoue en « ia_indisponible » ; sans file de motifs, le motif est ignoré.
  ia?: PasserelleIa;
  motifs?: { noter(instanceId: string, executionId: string, etape: string, texte: string): void };
}
