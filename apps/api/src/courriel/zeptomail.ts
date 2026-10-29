import type { LecteurSecrets } from "../secrets.js";
import type { Transport } from "./expediteur.js";

// Transport de production. La clé d'API est un secret de la plateforme : lue dans OpenBao au démarrage, jamais écrite ailleurs.
// Coffre scellé ou clé absente : la création échoue, aucune valeur de repli.

export const SECRET_ZEPTOMAIL = "plateforme/zeptomail";
const URL_API = "https://api.zeptomail.eu/v1.1/email";

export interface OptionsZeptoMail { lecteur: LecteurSecrets; fetch?: typeof fetch; de: string; url?: string }

export async function creerTransportZeptoMail(o: OptionsZeptoMail): Promise<Transport> {
  const cle = await o.lecteur.lire(SECRET_ZEPTOMAIL);
  const appel = o.fetch ?? fetch;
  return {
    async envoyer(m) {
      const r = await appel(o.url ?? URL_API, {
        method: "POST",
        headers: { authorization: `Zoho-enczapikey ${cle}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ from: { address: m.de ?? o.de }, to: [{ email_address: { address: m.a } }], subject: m.sujet, textbody: m.texte }),
        redirect: "error", // la clé ne suit jamais une redirection
        signal: AbortSignal.timeout(10_000),
      });
      // Le corps de la réponse n'est jamais repris dans l'erreur.
      if (!r.ok) throw new Error(`ZeptoMail a répondu ${r.status}`);
    },
  };
}
