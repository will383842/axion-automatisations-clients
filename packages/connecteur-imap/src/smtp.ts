import { Readable } from "node:stream";
import { promisify } from "node:util";
import { ErreurConnecteur, type MessageSortant } from "@axion-auto/connecteurs-commun";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { estCoupure } from "./erreurs.ts";
import type { OptionsSmtp } from "./verification.ts";

// Message complet, avec le Message-ID choisi par le moteur : sert à l'envoi, au brouillon et à la copie dans « Envoyés ».
export async function composerMessage(m: MessageSortant, expediteur: string): Promise<Buffer> {
  const noeud = new MailComposer({ from: expediteur, to: m.destinataire, subject: m.objet, text: m.corps, messageId: m.messageId }).compile();
  return promisify(noeud.build.bind(noeud))();
}

// Envoi SMTP unique, sans réessai ; renvoie le message envoyé pour la copie. La connexion est fermée dans tous les cas.
// Le flux du message n'est lu qu'après la réponse à DATA : une coupure après cette lecture est « incertaine » (le message a pu partir), donc non rejouable.
export async function envoyerSmtp(options: OptionsSmtp, m: MessageSortant, expediteur: string, creer: typeof createTransport = createTransport): Promise<Buffer> {
  const raw = await composerMessage(m, expediteur);
  let commence = false;
  const flux = new Readable({ read() { commence = true; this.push(raw); this.push(null); } });
  const transport = creer({ ...options, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
  try {
    await transport.sendMail({ envelope: { from: expediteur, to: [m.destinataire] }, raw: flux });
    return raw;
  } catch (e) {
    if (commence && estCoupure(e)) throw new ErreurConnecteur("definitive", "envoi_incertain");
    throw e;
  } finally {
    transport.close();
  }
}
