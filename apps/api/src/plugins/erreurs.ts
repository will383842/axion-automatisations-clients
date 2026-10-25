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

export function brancherErreurs(serveur: FastifyInstance): void {
  serveur.setErrorHandler(async (erreur, requete, reponse) => {
    const code = codeDe(erreur);
    // Le message n'est repris que d'une ErreurApi : jamais celui d'une erreur inattendue (aucune fuite).
    const message = erreur instanceof ErreurApi ? erreur.message : (MESSAGES[code] ?? "Erreur.");
    if (code === "erreur_interne") requete.log.error({ err: erreur }, "erreur interne");
    return reponse.status(STATUT_PAR_CODE[code]).send({ erreur: { code, message, id_trace: requete.id } });
  });
  serveur.setNotFoundHandler(async (requete, reponse) =>
    reponse.status(STATUT_PAR_CODE.introuvable).send({ erreur: { code: "introuvable", message: MESSAGES.introuvable, id_trace: requete.id } }),
  );
}
