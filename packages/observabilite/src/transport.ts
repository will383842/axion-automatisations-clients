import { createTransport } from "@sentry/core";

// Transport de Sentry sur le fetch natif, INJECTABLE, avec un délai d'abandon de 2 s (A-113, C-025).
// Aucun transport hors ligne, aucune file sur disque, aucune relance : une enveloppe refusée ou perdue est abandonnée, jamais rejouée.
// Le nettoyage tourne avant (beforeSend) : le tampon du transport ne contient que des enveloppes déjà nettoyées.
export const DELAI_ENVOI_MS = 2000;

export type FetchInjecte = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "headers">>;

export function creerTransport(fetchInjecte: FetchInjecte) {
  return (options: Parameters<typeof createTransport>[0] & { url: string }) =>
    createTransport(options, async (requete) => {
      const reponse = await fetchInjecte(options.url, {
        method: "POST",
        body: requete.body as string,
        signal: AbortSignal.timeout(DELAI_ENVOI_MS),
      });
      return {
        statusCode: reponse.status,
        headers: { "x-sentry-rate-limits": reponse.headers.get("x-sentry-rate-limits"), "retry-after": reponse.headers.get("retry-after") },
      };
    });
}
