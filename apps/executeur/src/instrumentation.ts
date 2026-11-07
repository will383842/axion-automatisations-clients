import { demarrerDepuisEnvironnement, type SentryDemarre } from "@axion-auto/observabilite/sentry";
import type { FetchInjecte } from "@axion-auto/observabilite/transport";

// Instrumentation Sentry de l'application « executeur » (A-113, C-025). Module seul : son appel depuis le vrai démarrage
// reste une dette des fiches de câblage (index.ts ne démarre rien aujourd'hui). Sans DSN européen, le démarrage est refusé.
export function demarrerInstrumentation(env: Record<string, string | undefined>, deps: { fetch?: FetchInjecte; masquerSecrets?: (texte: string) => string } = {}): SentryDemarre {
  return demarrerDepuisEnvironnement(env, "executeur", deps);
}
