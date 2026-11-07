import { createStackParser, type Event } from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import { creerTransport, type FetchInjecte } from "./transport.ts";
import { type Application, avantEnvoi, type ContexteNettoyage, type EvenementNettoye } from "./nettoyage.ts";

// Initialisation commune de Sentry pour l'API, l'exécuteur et la console (A-113, C-025).
// Le client Sentry est injecté : le paquet ne dépend d'aucune bibliothèque tierce tant que le choix du SDK n'est pas tranché (voir les dettes de la PR).

export interface OptionsSentry {
  dsn: string;
  release: string;
  sendDefaultPii: false;
  tracesSampleRate: number;
  replaysSessionSampleRate: 0;
  replaysOnErrorSampleRate: 0;
  integrations: never[];
  maxBreadcrumbs: 0;
  beforeSend: (evenement: unknown) => EvenementNettoye | null;
  beforeSendTransaction: (transaction: unknown) => null;
  beforeSendSpan: (span: unknown) => null;
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
  masquerSecrets?: (texte: string) => string;
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
  const contexte: ContexteNettoyage = { application: config.application, ...(config.masquerSecrets ? { masquerSecrets: config.masquerSecrets } : {}) };
  config.sentry.init({
    dsn: config.dsn,
    release: config.version,
    sendDefaultPii: false,
    tracesSampleRate: config.echantillonnage ?? 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    integrations: [],
    maxBreadcrumbs: 0,
    beforeSend: (evenement) => avantEnvoi(evenement, contexte),
    beforeSendTransaction: () => null,
    beforeSendSpan: () => null,
    beforeBreadcrumb: () => null,
  });
}

// Lignes de pile Node « at fonction (fichier:ligne:colonne) » : seul le nom de fichier et la fonction servent ; le nettoyage retire le chemin.
const LIGNE_PILE = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/;
const stackParser = createStackParser([30, (ligne) => {
  const m = LIGNE_PILE.exec(ligne);
  return m ? { filename: m[2] ?? "", function: m[1] ?? "?", lineno: Number(m[3]) } : undefined;
}]);

export interface ConfigDemarrage {
  dsn: string;
  application: Application;
  version: string;
  cellule?: string;
  instance?: string;
  echantillonnage?: number;
  masquerSecrets?: (texte: string) => string;
  // Fetch injecté ; par défaut, celui de Node. Les essais le remplacent, jamais le DSN.
  fetch?: FetchInjecte;
}

export interface SentryDemarre {
  client: ServerRuntimeClient;
  // Rend la main tout de suite ; la route (adresse de la requête) est réduite par le nettoyage.
  capturer: (erreur: unknown, route?: string) => void;
  vider: (delaiMs?: number) => Promise<boolean>;
}

// Démarre le SDK @sentry/core seul : aucune intégration, aucune transaction, aucun fil d'Ariane, aucun nom de serveur.
export function demarrerSentry(config: ConfigDemarrage): SentryDemarre {
  const appeler: FetchInjecte = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let client: ServerRuntimeClient | undefined;
  configurerSentry({
    dsn: config.dsn,
    application: config.application,
    version: config.version,
    ...(config.echantillonnage !== undefined ? { echantillonnage: config.echantillonnage } : {}),
    ...(config.masquerSecrets ? { masquerSecrets: config.masquerSecrets } : {}),
    sentry: {
      init: (o) => {
        client = new ServerRuntimeClient({
          dsn: o.dsn,
          release: o.release,
          sendDefaultPii: false,
          tracesSampleRate: o.tracesSampleRate,
          integrations: [],
          maxBreadcrumbs: 0,
          // « static » : sinon le SDK ignore beforeSendTransaction et ajoute l'intégration d'envoi des spans (« stream » par défaut).
          traceLifecycle: "static",
          stackParser,
          transport: creerTransport(appeler),
          beforeSend: o.beforeSend as never,
          beforeSendTransaction: o.beforeSendTransaction,
          beforeSendSpan: o.beforeSendSpan as never,
          beforeBreadcrumb: o.beforeBreadcrumb,
        });
        client.init();
      },
    },
  });
  const actif = client as ServerRuntimeClient;
  const enCours = new Set<Promise<void>>();
  return {
    client: actif,
    capturer: (erreur, route) => {
      const travail: Promise<void> = Promise.resolve(actif.eventFromException(erreur)).then((evenement: Event) => {
        if (route) evenement.request = { url: route };
        evenement.contexts = { app: { cellule: config.cellule ?? "", instance: config.instance ?? "" } };
        actif.captureEvent(evenement);
      }, () => undefined).finally(() => { enCours.delete(travail); });
      enCours.add(travail);
    },
    vider: async (delaiMs = 2000) => {
      await Promise.all([...enCours]);
      return actif.flush(delaiMs);
    },
  };
}

// Lit SENTRY_DSN, SENTRY_ECHANTILLONNAGE, SENTRY_CELLULE et APP_VERSION (inventaire des secrets). Sans DSN : démarrage refusé.
export function demarrerDepuisEnvironnement(env: Record<string, string | undefined>, application: Application, deps: { fetch?: FetchInjecte; masquerSecrets?: (texte: string) => string } = {}): SentryDemarre {
  const taux = Number(env["SENTRY_ECHANTILLONNAGE"] ?? "0");
  return demarrerSentry({
    dsn: env["SENTRY_DSN"] ?? "",
    application,
    version: env["APP_VERSION"] || "inconnue",
    cellule: env["SENTRY_CELLULE"] ?? "",
    echantillonnage: Number.isFinite(taux) && taux >= 0 && taux <= 1 ? taux : 0,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.masquerSecrets ? { masquerSecrets: deps.masquerSecrets } : {}),
  });
}
