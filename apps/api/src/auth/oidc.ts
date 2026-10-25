import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";

// Vérification des jetons Keycloak (C-001). Émetteur et audience exacts : un jeton d'un autre royaume est refusé.
// Algorithmes asymétriques nommés : « none » et les algorithmes à secret partagé (confusion avec la clé publique) sont refusés.
const ALGORITHMES = ["RS256", "PS256", "ES256"];

export type Verificateur = (jeton: string) => Promise<JWTPayload>;
export interface Identite extends JWTPayload {
  auth_time?: unknown;
  acr?: unknown;
}

declare module "fastify" {
  interface FastifyRequest {
    identite?: Identite;
  }
}

export function creerVerificateur(options: { emetteur: string; audience: string; cles: JWTVerifyGetKey }): Verificateur {
  return async (jeton) => {
    const { payload } = await jwtVerify(jeton, options.cles, {
      issuer: options.emetteur,
      audience: options.audience,
      algorithms: ALGORITHMES,
      requiredClaims: ["exp", "iss", "aud", "sub"],
    });
    return payload;
  };
}

// Réponse au format commun des erreurs, sans détail de l'échec ; le code « signature_invalide » (401) existe déjà dans les contrats.
export function refuser(requete: FastifyRequest, reponse: FastifyReply, code: string, message: string): FastifyReply {
  return reponse.status(401).send({ erreur: { code, message, id_trace: requete.id } });
}

// Un seul en-tête « Authorization: Bearer <jeton> », rien d'autre.
function jetonDe(requete: FastifyRequest): string | undefined {
  const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(requete.headers.authorization ?? "");
  return m?.[1];
}

export function exigerJeton(verificateur: Verificateur): preHandlerAsyncHookHandler {
  return async (requete, reponse) => {
    const jeton = jetonDe(requete);
    if (!jeton) return refuser(requete, reponse, "signature_invalide", "Connexion requise.");
    try {
      requete.identite = await verificateur(jeton);
    } catch {
      return refuser(requete, reponse, "signature_invalide", "Connexion requise.");
    }
  };
}
