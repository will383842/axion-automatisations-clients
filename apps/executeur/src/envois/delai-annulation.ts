import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import type { Travail } from "../files/travailleur.ts";
import { gardeIndisponible, type ValkeyEnvois } from "./arret-urgence.ts";

// Délai d'annulation (C-576) tenu par le serveur : l'envoi d'un brouillon validé attend 10 s dans la file.
export const DELAI_ANNULATION_MS = 10_000;
const SEPT_JOURS_S = 7 * 24 * 3600;
const EXECUTION = /^[A-Za-z0-9_-]{1,128}$/;

export function cleAnnulation(executionId: string): string {
  if (!EXECUTION.test(executionId)) throw new ErreurConnecteur("definitive", "execution_invalide");
  return `executeur:annulation:${executionId}`;
}

// Passagère pour la même raison que l'arrêt : jamais « echec » au journal. Le gestionnaire termine le travail, marqué annule.
export class EnvoiAnnule extends ErreurConnecteur {
  constructor() {
    super("passagere", "envoi_annule");
  }
}

export interface FileEnvois {
  add(nom: string, data: Record<string, unknown>, opts: { jobId: string; delay: number }): Promise<unknown>;
}

// Le délai est tenu par la file ; même jobId = un seul travail pour un double clic.
export function planifierEnvoiAnnulable(file: FileEnvois, travail: Travail): Promise<unknown> {
  cleAnnulation(travail.id);
  return file.add("envoi", { ...travail, annulable: true }, { jobId: `envoi-${travail.id}`, delay: DELAI_ANNULATION_MS });
}

// Une seule commande atomique : « annule » et « parti » sont terminaux ; « annule » n'expire pas (un travail arrêté puis relancé ne doit jamais partir).
export async function annulerEnvoi(valkey: ValkeyEnvois, executionId: string): Promise<"annule" | "deja_annule" | "trop_tard"> {
  const avant = await valkey.call("SET", cleAnnulation(executionId), "annule", "NX", "GET");
  return avant === null || avant === undefined ? "annule" : avant === "parti" ? "trop_tard" : "deja_annule";
}

// Juste avant l'appel : marque « parti » (jamais écrasé) ou refuse si l'envoi a été annulé. Tout échec de Valkey = refus.
export async function reserverDepart(valkey: ValkeyEnvois, executionId: string): Promise<void> {
  let avant: unknown;
  try {
    avant = await valkey.call("SET", cleAnnulation(executionId), "parti", "NX", "GET", "EX", String(SEPT_JOURS_S));
  } catch {
    throw gardeIndisponible();
  }
  if (avant === "annule") throw new EnvoiAnnule();
}
