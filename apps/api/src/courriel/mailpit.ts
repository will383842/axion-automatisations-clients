import { connect } from "node:net";
import type { Message, Transport } from "./expediteur.js";

// Transport de la CI : SMTP simple vers Mailpit, hôte local seulement (aucun test ne peut viser un vrai serveur).

const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost"]);
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
const coupe = (t: string) => t.replace(/(.{76})/g, "$1\r\n");

export interface OptionsMailpit { de: string; smtp: { host: string; port: number } }

export function creerTransportMailpit(o: OptionsMailpit): Transport {
  if (!HOTES_LOCAUX.has(o.smtp.host)) throw new Error("Mailpit : hôte refusé, le piège doit être local");
  return {
    envoyer: (m: Message) =>
      new Promise<void>((ok, ko) => {
        const prises = connect(o.smtp.port, o.smtp.host);
        prises.setTimeout(10_000, () => prises.destroy(new Error("Mailpit : délai dépassé")));
        const etapes = [
          "", // salutation du serveur
          "EHLO console.test",
          `MAIL FROM:<${m.de ?? o.de}>`,
          `RCPT TO:<${m.a}>`,
          "DATA",
          [
            `From: ${m.de ?? o.de}`,
            `To: ${m.a}`,
            `Subject: =?UTF-8?B?${b64(m.sujet)}?=`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: base64",
            "",
            coupe(b64(m.texte)),
            ".",
          ].join("\r\n"),
          "QUIT",
        ];
        let i = 0;
        let reste = "";
        prises.on("error", ko);
        prises.on("close", () => (i >= etapes.length ? ok() : ko(new Error("Mailpit : connexion fermée"))));
        prises.on("data", (b: Buffer) => {
          reste += b.toString("utf8");
          // Réponse complète = dernière ligne « 250 texte » (les lignes « 250-… » continuent).
          const lignes = reste.split("\r\n").filter(Boolean);
          const derniere = lignes.at(-1) ?? "";
          if (!reste.endsWith("\r\n") || /^\d{3}-/.test(derniere)) return;
          reste = "";
          if (!/^[23]/.test(derniere)) return void prises.destroy(new Error("Mailpit a refusé le message"));
          const suite = etapes[++i];
          if (suite !== undefined) prises.write(`${suite}\r\n`);
          else prises.end();
        });
      }),
  };
}
