import type { Redis } from "ioredis";
import { PlacesValkey, type Places } from "../files/semaphore.ts";
import type { LimitesDonnees } from "./limites.ts";

// File de lecture PARTAGÉE entre les processus de l'exécuteur (T4-50e-1) : CONNECTION LIMIT de `_lecture` (2) vaut pour toute la grappe, pas pour un processus.
// Une seule place par client pour tout l'exécuteur (la 2e reste à la console). La clé ne contient PAS la cellule : deux cellules qui lisent le même client partagent la place.
// Limite : elle ne protège que les exécuteurs qui partagent le même Valkey ; la vraie borne reste CONNECTION LIMIT.
export interface FileLecture {
  // Vrai : la place est tenue. Faux : le signal a été levé avant d'obtenir la place. Lève si la file est injoignable (l'appelant ne lit alors PAS).
  prendre(tenantId: string, proprietaire: string, signal: AbortSignal): Promise<boolean>;
  rendre(tenantId: string, proprietaire: string): Promise<void>;
}

export const CLE_FILE_LECTURE = "donnees:lecture";
export const PLACES_PAR_CLIENT = 1;
const SONDAGE_MS = 50;
const SONDAGE_MAX_MS = 500;

// Le bail couvre la lecture en vol la plus longue : délai total, deux requêtes (sonde et lecture), marge. Une place perdue par un processus tué revient après lui.
export const bailFileLecture = (l: Pick<LimitesDonnees, "delaiMs" | "delaiTotalMs">): number => l.delaiTotalMs + 2 * l.delaiMs + 5000;

// Sans file partagée (un seul processus, essais) : la file locale du port suffit à servir une lecture à la fois par client.
export const fileLocale: FileLecture = { prendre: async () => true, rendre: async () => undefined };

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((ok) => {
    const fin = (): void => { clearTimeout(minuteur); signal.removeEventListener("abort", fin); ok(); };
    const minuteur = setTimeout(fin, ms);
    signal.addEventListener("abort", fin, { once: true });
  });

export function creerFileParPlaces(places: Places, limites: Pick<LimitesDonnees, "delaiMs" | "delaiTotalMs">): FileLecture {
  const bail = bailFileLecture(limites);
  return {
    async prendre(tenantId, proprietaire, signal) {
      let attente = SONDAGE_MS;
      for (;;) {
        if (signal.aborted) return false;
        if (await places.prendre(tenantId, PLACES_PAR_CLIENT, proprietaire, bail)) return true;
        await pause(attente, signal);
        attente = Math.min(attente * 2, SONDAGE_MAX_MS);
      }
    },
    rendre: (tenantId, proprietaire) => places.rendre(tenantId, proprietaire),
  };
}

export const creerFileValkey = (client: Redis, limites: Pick<LimitesDonnees, "delaiMs" | "delaiTotalMs">): FileLecture =>
  creerFileParPlaces(new PlacesValkey(client, CLE_FILE_LECTURE), limites);
