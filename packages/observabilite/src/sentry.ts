import { type Application, avantEnvoi, type EvenementNettoye } from "./nettoyage.ts";

// Initialisation commune de Sentry pour l'API, l'exécuteur et la console (A-113, C-025).
// Le client Sentry est injecté : le paquet ne dépend d'aucune bibliothèque tierce tant que le choix du SDK n'est pas tranché (voir les dettes de la PR).

export interface OptionsSentry {
  dsn: string;
  release: string;
  sendDefaultPii: false;
  tracesSampleRate: number;
  replaysSessionSampleRate: 0;
  replaysOnErrorSampleRate: 0;
  beforeSend: (evenement: unknown) => EvenementNettoye | null;
  beforeBreadcrumb: (fil: unknown) => null;
}

export interface ClientSentry {
  init: (options: OptionsSentry) => void;
}

export interface ConfigSentry {
  dsn: string;
  application: Application;
  version: string;
  sentry: ClientSentry;
  echantillonnage?: number;
}

// Adresses de collecte de la région européenne de Sentry : <clé>@<organisation>.ingest.de.sentry.io, ou un hôte auto-hébergé inscrit à l'ADR (hôtes se terminant par .de.sentry.io seulement ici).
function estEuropeen(dsn: string): boolean {
  try {
    const hote = new URL(dsn).hostname;
    return hote === "de.sentry.io" || hote.endsWith(".de.sentry.io");
  } catch {
    return false;
  }
}

export function configurerSentry(config: ConfigSentry): void {
  if (config.dsn.trim() === "") throw new Error("Sentry : DSN absent de la configuration. Renseignez-le avant de démarrer " + config.application + ".");
  if (!estEuropeen(config.dsn)) throw new Error("Sentry : l'adresse n'est pas dans la région européenne (*.de.sentry.io). Démarrage refusé pour " + config.application + " ; voir l'ADR du choix de région.");
  config.sentry.init({
    dsn: config.dsn,
    release: config.version,
    sendDefaultPii: false,
    tracesSampleRate: config.echantillonnage ?? 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: (evenement) => avantEnvoi(evenement, { application: config.application }),
    beforeBreadcrumb: () => null,
  });
}
