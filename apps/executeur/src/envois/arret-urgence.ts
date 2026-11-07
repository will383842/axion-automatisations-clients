import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";

// Arrêt d'urgence des envois (C-534). L'exécuteur LIT ces clés à chaque envoi ; il ne les pose ni ne les lève jamais (seule la console le fait, ADR 0130).
// « Clé présente = arrêt posé », quelle que soit sa valeur. Les clés restent hors du préfixe BullMQ.
export const CLE_ARRET_GLOBAL = "executeur:arret:global";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DELAI_LECTURE_MS = 1_000;

// Le client est validé avant de construire la clé : ni « : », ni « * », ni espace.
export function cleArretClient(tenantId: string): string {
  if (!UUID.test(tenantId)) throw new ErreurConnecteur("definitive", "client_invalide");
  return `executeur:arret:client:${tenantId}`;
}

// Le sous-ensemble de Valkey (ioredis) que touchent les gardes.
export interface ValkeyEnvois {
  mget(...cles: string[]): Promise<(string | null)[]>;
  call(commande: string, ...args: string[]): Promise<unknown>;
}

// Passagère : sans quoi la machine inscrirait « echec » et le travail ne repartirait jamais (perte silencieuse).
export class ArretEnvoisPose extends ErreurConnecteur {
  constructor() {
    super("passagere", "arret_urgence");
  }
}

export const gardeIndisponible = () => new ErreurConnecteur("passagere", "garde_indisponible");

// Sûr par défaut : Valkey injoignable ou trop lent = refus. Une seule lecture, sans cache.
export async function lireArret(valkey: ValkeyEnvois, tenantId: string, delaiMs = DELAI_LECTURE_MS): Promise<boolean> {
  const cles = [CLE_ARRET_GLOBAL, cleArretClient(tenantId)];
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  try {
    const valeurs = await Promise.race([
      valkey.mget(...cles),
      new Promise<never>((_, rejeter) => void (minuterie = setTimeout(() => rejeter(new Error("delai")), delaiMs))),
    ]);
    return valeurs.some((v) => v !== null && v !== undefined);
  } catch {
    throw gardeIndisponible();
  } finally {
    clearTimeout(minuterie);
  }
}
