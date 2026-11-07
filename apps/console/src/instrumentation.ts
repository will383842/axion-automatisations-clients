import type { SentryDemarre } from "@axion-auto/observabilite/sentry";

// Instrumentation Sentry de la console (A-113, C-025) : Next appelle register() au démarrage du serveur et onRequestError() à chaque erreur de requête.
// Le SDK n'est chargé que sous le moteur nodejs (jamais pour l'edge ni le navigateur). Aucune capture côté navigateur (dette).
// Sans SENTRY_DSN, la console démarre sans signalement (interrupteur fermé par défaut) ; avec un DSN hors de *.de.sentry.io, le démarrage est refusé.
let sentry: SentryDemarre | undefined;

export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  if ((process.env["SENTRY_DSN"] ?? "") === "") return;
  const { demarrerDepuisEnvironnement } = await import("@axion-auto/observabilite/sentry");
  sentry = demarrerDepuisEnvironnement(process.env, "console");
}

export async function onRequestError(erreur: unknown, requete: { path: string; method?: string; headers?: unknown }): Promise<void> {
  if (!sentry) return;
  sentry.capturer(erreur, requete.path);
  await sentry.vider(500);
}
