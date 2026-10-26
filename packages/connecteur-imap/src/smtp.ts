import { promisify } from "node:util";
import type { MessageSortant } from "@axion-auto/connecteurs-commun";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { OptionsSmtp } from "./verification.ts";

// Message complet, avec le Message-ID choisi par le moteur : sert à l'envoi, au brouillon et à la copie dans « Envoyés ».
export async function composerMessage(m: MessageSortant, expediteur: string): Promise<Buffer> {
  const noeud = new MailComposer({ from: expediteur, to: m.destinataire, subject: m.objet, text: m.corps, messageId: m.messageId }).compile();
  return promisify(noeud.build.bind(noeud))();
}

// Envoi SMTP unique, sans réessai ; renvoie le message envoyé pour la copie. La connexion est fermée dans tous les cas.
export async function envoyerSmtp(options: OptionsSmtp, m: MessageSortant, expediteur: string): Promise<Buffer> {
  const raw = await composerMessage(m, expediteur);
  const transport = createTransport({ ...options, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
  try {
    await transport.sendMail({ envelope: { from: expediteur, to: [m.destinataire] }, raw });
    return raw;
  } finally {
    transport.close();
  }
}
