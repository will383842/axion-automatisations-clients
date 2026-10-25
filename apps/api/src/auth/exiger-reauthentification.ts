import type { preHandlerAsyncHookHandler } from "fastify";
import { refuser } from "./oidc.ts";

// Réauthentification des actions sensibles (C-003) : connexion de moins de 5 minutes ET double facteur (acr « mfa »).
// À placer APRÈS exigerJeton. Le code « reauthentification_requise » n'est pas encore dans packages/contrats : voir la description de la PR.
const AGE_MAX_SECONDES = 300;
const TOLERANCE_HORLOGE_SECONDES = 5;
const NIVEAU_DOUBLE_FACTEUR = "mfa";

export function exigerReauthentification(maintenant: () => number = () => Date.now()): preHandlerAsyncHookHandler {
  return async (requete, reponse) => {
    const { auth_time: connexion, acr } = requete.identite ?? {};
    const age = typeof connexion === "number" && Number.isFinite(connexion) ? Math.floor(maintenant() / 1000) - connexion : NaN;
    const recent = age >= -TOLERANCE_HORLOGE_SECONDES && age <= AGE_MAX_SECONDES;
    if (!recent || acr !== NIVEAU_DOUBLE_FACTEUR) {
      return refuser(requete, reponse, "reauthentification_requise", "Reconnectez-vous pour continuer.");
    }
  };
}
