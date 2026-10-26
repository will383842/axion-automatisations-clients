import { ErreurCoffre, type OptionsBao } from "./coffre/coffre.js";
import type { Masqueur } from "./plugins/journal.js";
import type { LecteurSecrets } from "./secrets.js";

// Implémentation OpenBao de LecteurSecrets : KV v2 monté sur technique/, un champ « valeur » par secret.
// Le jeton injecté décide de ce qui se lit (politiques d'OpenBao) ; ce fichier n'élargit aucun droit.
// Chaque valeur lue est inscrite au masqueur du journal avant d'être rendue (A-005).

export interface OptionsLecteur extends OptionsBao {
  masqueur?: Masqueur;
}

const DELAI_MS = 5000;
// Segments simples en minuscules : ni « .. », ni « ? », ni « % », ni barre double ou finale.
const NOM = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export function creerLecteurSecretsOpenBao(o: OptionsLecteur): LecteurSecrets {
  return {
    async lire(nom) {
      if (typeof nom !== "string" || !NOM.test(nom)) throw new ErreurCoffre("requete_refusee");
      let reponse: Response;
      try {
        reponse = await (o.fetch ?? fetch)(`${o.url}/v1/technique/data/${nom}`, {
          headers: { "X-Vault-Token": o.jeton },
          redirect: "error", // le jeton ne suit jamais une redirection
          signal: AbortSignal.timeout(DELAI_MS),
        });
      } catch {
        throw new ErreurCoffre("coffre_indisponible");
      }
      // Le corps d'une réponse en erreur n'est jamais repris dans l'erreur.
      if (reponse.status === 503) throw new ErreurCoffre((await reponse.text().catch(() => "")).toLowerCase().includes("sealed") ? "coffre_scelle" : "coffre_indisponible");
      if (reponse.status === 403) throw new ErreurCoffre("refuse");
      if (reponse.status === 404) throw new ErreurCoffre("introuvable");
      if (reponse.status >= 500) throw new ErreurCoffre("coffre_indisponible");
      if (reponse.status >= 300) throw new ErreurCoffre("requete_refusee");
      let valeur: unknown;
      try {
        valeur = ((await reponse.json()) as { data?: { data?: { valeur?: unknown } } } | null)?.data?.data?.valeur;
      } catch {
        throw new ErreurCoffre("coffre_indisponible");
      }
      if (typeof valeur !== "string" || !valeur) throw new ErreurCoffre("coffre_indisponible");
      o.masqueur?.ajouter(valeur);
      return valeur;
    },
  };
}
