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

// Faux transport : signale (ou non) le début de DATA au journal, puis tombe en panne comme une coupure réseau.
const transportQuiCoupe = (debutDeData: boolean) => (opts: { logger: { debug: (e: unknown) => void } }) => ({
  sendMail: async () => {
    if (debutDeData) opts.logger.debug({ tnx: "message" });
    throw Object.assign(new Error("coupure"), { code: "ECONNRESET" });
  },
  close: () => undefined,
});
const options = optionsSmtp(verifierConfiguration({ hoteImap: "imap.exemple.test", hoteSmtp: "smtp.exemple.test", utilisateur: "instance-essai", expediteur: "atelier@exemple.fr" }), "jeton-fictif");
const sortant = { messageId: "<m-2.essai@exemple.fr>", destinataire: "client@exemple.fr", objet: "Essai", corps: "Bonjour" };

describe("coupure pendant l'envoi", () => {
  it("[A-319] une coupure avant DATA reste passagère : le message n'est pas parti, on peut renvoyer", async () => {
    await expect(envoyerSmtp(options, sortant, "atelier@exemple.fr", transportQuiCoupe(false) as never)).rejects.toMatchObject({ code: "ECONNRESET" });
  });
  it("[A-319] une coupure après le début de DATA n'est pas rejouable : le message a pu partir", async () => {
    await expect(envoyerSmtp(options, sortant, "atelier@exemple.fr", transportQuiCoupe(true) as never)).rejects.toMatchObject({ classe: "definitive", code: "envoi_incertain" });
  });
});

// Faux serveur SMTP réel, sans TLS : répond jusqu'à la commande « coupeA » puis ferme la socket.
// « data » : la coupure arrive au premier octet reçu après la réponse 354 ; « rcpt » : dès la réception de RCPT.
async function serveurQuiCoupe(coupeA: "rcpt" | "data"): Promise<number> {
  serveur = createServer((s) => {
    let enDonnees = false;
    s.write("220 essai.test ESMTP\r\n");
    s.on("data", (d) => {
      const l = String(d);
      if (enDonnees) return void s.destroy();
      if (/^(EHLO|HELO)/i.test(l)) s.write("250 essai.test\r\n");
      else if (/^RCPT/i.test(l)) { if (coupeA === "rcpt") s.destroy(); else s.write("250 ok\r\n"); }
      else if (/^DATA/i.test(l)) { enDonnees = true; s.write("354 envoyez\r\n"); }
      else s.write("250 ok\r\n");
    });
    s.on("error", () => undefined);
  });
  await new Promise<void>((ok) => serveur?.listen(0, "127.0.0.1", ok));
  return (serveur.address() as { port: number }).port;
}
const optionsEnClair = (port: number) => ({ ...options, host: "127.0.0.1", port, secure: false, requireTLS: false, ignoreTLS: true as never, auth: undefined as never });

describe("coupure pendant l'envoi, contre un vrai serveur SMTP", () => {
  it("[A-319] une coupure à la réception de RCPT reste passagère : le message n'est pas parti", async () => {
    const port = await serveurQuiCoupe("rcpt");
    const erreur = await envoyerSmtp(optionsEnClair(port), sortant, "atelier@exemple.fr").catch((e: unknown) => e);
    expect(erreur).not.toMatchObject({ code: "envoi_incertain" });
    expect(erreur).toBeInstanceOf(Error);
  });
  it("[A-319] une coupure après le début de DATA reste envoi_incertain : le message a pu partir", async () => {
    const port = await serveurQuiCoupe("data");
    await expect(envoyerSmtp(optionsEnClair(port), sortant, "atelier@exemple.fr")).rejects.toMatchObject({ classe: "definitive", code: "envoi_incertain" });
  });
});
