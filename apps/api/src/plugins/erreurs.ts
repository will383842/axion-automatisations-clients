import type { FastifyError, FastifyInstance } from "fastify";
import { STATUT_PAR_CODE, type CodeErreur } from "../../../../packages/contrats/src/commun/erreurs.js";

// Toute erreur sort au format commun des contrats ; les codes et leurs statuts sont importés, jamais recopiés.
export class ErreurApi extends Error {
  constructor(readonly code: CodeErreur, message: string) { super(message); }
}

const MESSAGES: Partial<Record<CodeErreur, string>> = {
  schema_invalide: "Requête invalide.",
  introuvable: "Ressource introuvable.",
  debit_depasse: "Trop de requêtes.",
  porte_fermee: "Service indisponible.",
  erreur_interne: "Erreur interne.",
};

function codeDe(erreur: unknown): CodeErreur {
  if (erreur instanceof ErreurApi) return erreur.code;
  const statut = (erreur as Partial<FastifyError> | null)?.statusCode;
  if (typeof statut === "number" && statut >= 400 && statut < 500) return statut === 429 ? "debit_depasse" : statut === 404 ? "introuvable" : "schema_invalide";
  return "erreur_interne";
}

export interface OptionsErreurs {
  // Rappel optionnel (Sentry) : appelé pour les seules erreurs internes (5xx), jamais pour un 4xx, avec l'adresse de la requête (le nettoyage la réduit) et sans corps.
  signaler?: (erreur: unknown, route?: string) => void;
}

export function brancherErreurs(serveur: FastifyInstance, options: OptionsErreurs = {}): void {
  serveur.setErrorHandler(async (erreur, requete, reponse) => {
    const code = codeDe(erreur);
    // Le message n'est repris que d'une ErreurApi : jamais celui d'une erreur inattendue (aucune fuite).
    const message = erreur instanceof ErreurApi ? erreur.message : (MESSAGES[code] ?? "Erreur.");
    if (code === "erreur_interne") {
      requete.log.error({ err: erreur }, "erreur interne");
      try { options.signaler?.(erreur, requete.url); } catch { /* le signalement ne change jamais la réponse */ }
    }
    // 413 (corps trop gros) : statut propre de Fastify, hors de la liste fermée des codes ; le corps garde le code schema_invalide.
    const statut = (erreur as Partial<FastifyError>).statusCode === 413 ? 413 : STATUT_PAR_CODE[code];
    return reponse.status(statut).send({ erreur: { code, message, id_trace: requete.id } });
  });
  serveur.setNotFoundHandler(async (requete, reponse) =>
    reponse.status(STATUT_PAR_CODE.introuvable).send({ erreur: { code: "introuvable", message: MESSAGES.introuvable, id_trace: requete.id } }),
  );
}
