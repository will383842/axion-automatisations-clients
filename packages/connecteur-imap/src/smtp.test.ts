import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { envoyerSmtp } from "./smtp.ts";
import { optionsSmtp, verifierConfiguration } from "./verification.ts";

let serveur: Server | undefined;
afterEach(() => new Promise<void>((ok) => (serveur ? serveur.close(() => ok()) : ok())));

// Faux serveur SMTP local, sans TLS : annonce EHLO sans STARTTLS et note si une commande de message arrive.
async function serveurEnClair(): Promise<{ port: number; commandes: string[] }> {
  const commandes: string[] = [];
  serveur = createServer((s) => {
    s.write("220 essai.test ESMTP\r\n");
    s.on("data", (d) => {
      const l = String(d);
      commandes.push(l.trim());
      if (/^(EHLO|HELO)/i.test(l)) s.write("250 essai.test\r\n");
      else if (/^QUIT/i.test(l)) s.end("221 au revoir\r\n");
      else s.write("250 ok\r\n");
    });
    s.on("error", () => undefined);
  });
  await new Promise<void>((ok) => serveur?.listen(0, "127.0.0.1", ok));
  return { port: (serveur.address() as { port: number }).port, commandes };
}

describe("SMTP sans repli en clair", () => {
  it("[A-389] un serveur sans TLS est refusé : ni identifiant ni message ne partent", async () => {
    const { port, commandes } = await serveurEnClair();
    const c = verifierConfiguration({ hoteImap: "127.0.0.1", hoteSmtp: "127.0.0.1", portSmtp: 587, chiffrementSmtp: "starttls", utilisateur: "instance-essai", expediteur: "atelier@exemple.fr" });
    const options = { ...optionsSmtp(c, "jeton-fictif"), port };
    await expect(envoyerSmtp(options, { messageId: "<m-1.essai@exemple.fr>", destinataire: "client@exemple.fr", objet: "Essai", corps: "Bonjour" }, "atelier@exemple.fr")).rejects.toBeTruthy();
    expect(commandes.some((l) => /^(AUTH|MAIL|DATA)/i.test(l))).toBe(false);
  });
});
