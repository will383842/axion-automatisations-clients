import { ErreurConnecteur, avecJeton, type JetonCourt } from "@axion-auto/connecteurs-commun";
import { erreurDeReponse } from "./erreurs.ts";

export type OptionsGmail = { url: string; fetch?: typeof fetch; maintenant?: () => number; delaiMs?: number };
export const DELAI_GMAIL_MS = 15_000;
export type ClientGmail = ReturnType<typeof creerClientGmail>;

const RACINE = "/gmail/v1/users/me";

// Client HTTP minimal de l'API Gmail v1 (fetch, aucune bibliothèque Google). Les chemins sont relatifs à `users/me`.
export function creerClientGmail(options: OptionsGmail) {
  const base = options.url.replace(/\/+$/, "");
  const appeler = options.fetch ?? fetch;
  const maintenant = options.maintenant ?? Date.now;
  const delai = options.delaiMs ?? DELAI_GMAIL_MS;
  return {
    async requete(jeton: JetonCourt, methode: "GET" | "POST", chemin: string, corps?: unknown): Promise<unknown> {
      // Délai maximal sur l'appel et sur la lecture du corps : un Gmail muet ne bloque jamais l'appelant.
      const signal = AbortSignal.timeout(delai);
      try {
        const reponse = await avecJeton(jeton, maintenant(), (valeur) =>
          appeler(`${base}${RACINE}${chemin}`, {
            method: methode,
            redirect: "error",
            signal,
            headers: { authorization: `Bearer ${valeur}`, accept: "application/json", ...(corps === undefined ? {} : { "content-type": "application/json" }) },
            ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
          }),
        );
        const texte = await reponse.text();
        if (!reponse.ok) throw erreurDeReponse(reponse.status, reponse.headers, texte, maintenant());
        if (!texte) return undefined;
        try {
          return JSON.parse(texte);
        } catch {
          throw new ErreurConnecteur("definitive", "reponse_illisible");
        }
      } catch (e) {
        if (signal.aborted && !(e instanceof ErreurConnecteur)) throw new ErreurConnecteur("passagere", "delai_depasse");
        throw e;
      }
    },
  };
}
