import { ErreurConnecteur, avecJeton, type JetonCourt } from "@axion-auto/connecteurs-commun";
import { erreurDeReponse } from "./erreurs.ts";

export type OptionsGraph = { url: string; fetch?: typeof fetch; maintenant?: () => number };
export type ClientGraph = ReturnType<typeof creerClientGraph>;

// Client HTTP minimal de Graph v1.0. Une adresse absolue (curseur rendu par Graph) doit rester sous l'adresse de base.
export function creerClientGraph(options: OptionsGraph) {
  const base = options.url.replace(/\/+$/, "");
  const appeler = options.fetch ?? fetch;
  const maintenant = options.maintenant ?? Date.now;
  return {
    base,
    async requete(jeton: JetonCourt, methode: "GET" | "POST" | "PATCH", chemin: string, corps?: unknown): Promise<unknown> {
      const absolue = /^https?:\/\//.test(chemin);
      if (absolue && !chemin.startsWith(`${base}/`)) throw new ErreurConnecteur("definitive", "curseur_invalide");
      const reponse = await avecJeton(jeton, maintenant(), (valeur) =>
        appeler(absolue ? chemin : `${base}${chemin}`, {
          method: methode,
          redirect: "error",
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
    },
  };
}
