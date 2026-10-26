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
// nodemailer lit le flux brut dès la préparation, bien avant DATA : on ne s'en sert pas pour savoir si le message est parti.
// Le vrai début de DATA est le premier octet du message écrit sur la socket après la réponse 354 ; nodemailer le signale au journal (entrée « message » en mode debug).
// Une coupure après ce début est « incertaine » (le message a pu partir), donc non rejouable ; avant, elle reste passagère.
export async function envoyerSmtp(options: OptionsSmtp, m: MessageSortant, expediteur: string, creer: typeof createTransport = createTransport): Promise<Buffer> {
  const raw = await composerMessage(m, expediteur);
  let commence = false;
  const rien = () => undefined;
  const journal = { level: rien, trace: rien, info: rien, warn: rien, error: rien, fatal: rien, debug: (entree: unknown) => { if ((entree as { tnx?: string } | undefined)?.tnx === "message") commence = true; } };
  const transport = creer({ ...options, debug: true, logger: journal, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
  try {
    await transport.sendMail({ envelope: { from: expediteur, to: [m.destinataire] }, raw });
    return raw;
  } catch (e) {
    if (commence && estCoupure(e)) throw new ErreurConnecteur("definitive", "envoi_incertain");
    throw e;
  } finally {
    transport.close();
  }
}
