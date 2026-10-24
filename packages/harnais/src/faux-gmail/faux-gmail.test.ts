import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit, type ClientMailpit } from "../mailpit.js";
import { demarrerFauxGmail, type FauxGmail } from "./serveur.js";

const mailpit = creerClientMailpit();
const itMailpit = process.env["MAILPIT_API"] ? it : it.skip; // fiche: T0-20
let gmail: FauxGmail;

// Les fichiers de test partagent un seul Mailpit : chaque test écrit à une adresse à lui et ne lit que celle-là.
const adresseUnique = () => `${randomUUID()}@exemple.fr`;
async function attendreA(adresse: string, nombre: number) {
  const fin = Date.now() + 10_000;
  for (;;) {
    const trouves = (await mailpit.lister()).filter((m) => m.To.some((a) => a.Address === adresse));
    if (trouves.length >= nombre || Date.now() > fin) return trouves;
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

const COMPTE = "faux.lemoine@exemple.fr";
const rfc822 = (id: string, entetes = "To: client@exemple.fr", corps = "Bonjour") =>
  Buffer.from(`Message-ID: <${id}>\r\nFrom: lemoine@exemple.fr\r\n${entetes}\r\nSubject: Devis\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${corps}`).toString("base64url");
const envoyerBrut = (raw: string, jeton = COMPTE, chemin = "/gmail/v1/users/me/messages/send") =>
  fetch(`${gmail.url}${chemin}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jeton}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
const envoyer = (id: string, destinataire = "client@exemple.fr", jeton = COMPTE) => envoyerBrut(rfc822(id, `To: ${destinataire}`), jeton);
const controle = (mode: string, reinitialiser = false) =>
  fetch(`${gmail.url}/__controle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reinitialiser }) });

// Mini serveur SMTP : garde l'enveloppe et le message tels que le faux Gmail les remet (sans Mailpit).
type Depot = { de: string; pour: string[]; donnees: string };
async function demarrerPuitsSmtp(): Promise<{ client: ClientMailpit; depots: Depot[]; arreter(): Promise<void> }> {
  const depots: Depot[] = [];
  const serveur: Server = createServer((socket) => {
    let depot: Depot = { de: "", pour: [], donnees: "" };
    let tampon = "";
    let enDonnees = false;
    socket.write("220 puits.test ESMTP\r\n");
    socket.on("data", (morceau) => {
      tampon += morceau.toString("utf8");
      for (;;) {
        if (enDonnees) {
          const fin = tampon.indexOf("\r\n.\r\n");
          if (fin < 0) return;
          depot.donnees = tampon.slice(0, fin);
          tampon = tampon.slice(fin + 5);
          depots.push(depot);
          depot = { de: "", pour: [], donnees: "" };
          enDonnees = false;
          socket.write("250 ok\r\n");
          continue;
        }
        const saut = tampon.indexOf("\r\n");
        if (saut < 0) return;
        const ligne = tampon.slice(0, saut);
        tampon = tampon.slice(saut + 2);
        const commande = ligne.slice(0, 4).toUpperCase();
        if (commande === "EHLO" || commande === "HELO") socket.write("250 puits.test\r\n");
        else if (commande === "MAIL") (depot.de = ligne.slice(ligne.indexOf("<") + 1, ligne.indexOf(">")), socket.write("250 ok\r\n"));
        else if (commande === "RCPT") (depot.pour.push(ligne.slice(ligne.indexOf("<") + 1, ligne.indexOf(">"))), socket.write("250 ok\r\n"));
        else if (commande === "DATA") (enDonnees = true, socket.write("354 go\r\n"));
        else if (commande === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const port = (serveur.address() as { port: number }).port;
  const client = creerClientMailpit({ api: "http://127.0.0.1:1", smtpHote: "127.0.0.1", smtpPort: port });
  return { client, depots, arreter: () => new Promise<void>((ok) => serveur.close(() => ok())) };
}

beforeAll(async () => {
  if (process.env["MAILPIT_API"]) await mailpit.attendrePret();
  gmail = await demarrerFauxGmail({ mailpit });
});
afterAll(async () => {
  await gmail.arreter();
});
beforeEach(async () => {
  await controle("normal", true);
});

describe("faux Gmail", () => {
  itMailpit("[C-592] un envoi par le faux Gmail arrive dans Mailpit et porte le libellé SENT", async () => {
    const dest = adresseUnique();
    const id = `${randomUUID()}@faux-gmail.test`;
    const r = await envoyer(id, dest);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { labelIds: string[] }).labelIds).toContain("SENT");
    expect(await attendreA(dest, 1)).toHaveLength(1);
    const q = encodeURIComponent(`rfc822msgid:${id}`);
    const liste = (await (await fetch(`${gmail.url}/gmail/v1/users/me/messages?q=${q}`, { headers: { authorization: `Bearer ${COMPTE}` } })).json()) as { messages?: unknown[] };
    expect(liste.messages).toHaveLength(1);
  });

  itMailpit("[C-592] faux Gmail en reponse_perdue : erreur réseau côté client ET message présent dans Mailpit", async () => {
    const dest = adresseUnique();
    await controle("reponse_perdue");
    await expect(envoyer(`${randomUUID()}@faux-gmail.test`, dest)).rejects.toThrow();
    expect(await attendreA(dest, 1)).toHaveLength(1);
  });

  itMailpit("[C-592] deux envois identiques par le faux Gmail donnent deux messages (aucune clé anti-doublon)", async () => {
    const dest = adresseUnique();
    const id = `${randomUUID()}@faux-gmail.test`;
    await envoyer(id, dest);
    await envoyer(id, dest);
    expect(await attendreA(dest, 2)).toHaveLength(2);
  });

  it("[C-592] faux Gmail en quota : 429 avec Retry-After", async () => {
    await controle("quota");
    const r = await envoyer("d1@faux-gmail.test");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("[C-592] faux Gmail : panne_generale 503, acces_refuse 403 (application bloquée)", async () => {
    await controle("panne_generale");
    expect((await envoyer("e1@faux-gmail.test")).status).toBe(503);
    await controle("acces_refuse");
    const r = await envoyer("e2@faux-gmail.test");
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).toContain("accessNotConfigured");
  });

  it("[C-592] attaque : sans jeton factice, 401 ; message sans raw ou destinataire non fictif, 400 ; mode inconnu, 400", async () => {
    expect((await envoyer("f1@faux-gmail.test", "client@exemple.fr", "vrai-jeton")).status).toBe(401);
    const sansRaw = await fetch(`${gmail.url}/gmail/v1/users/me/messages/send`, { method: "POST", headers: { authorization: `Bearer ${COMPTE}`, "content-type": "application/json" }, body: "{}" });
    expect(sansRaw.status).toBe(400);
    expect((await envoyer("f2@faux-gmail.test", "quelquun@exemple.com")).status).toBe(400);
    expect((await controle("n_importe_quoi")).status).toBe(400);
  });

  it("[C-592] attaque : le chemin encodé n'évite ni le jeton ni les pannes", async () => {
    const encode = "/%67mail/v1/users/me/messages/send";
    expect((await envoyerBrut(rfc822("g1@faux-gmail.test"), "vrai-jeton", encode)).status).toBe(401);
    await controle("panne_generale");
    expect((await envoyerBrut(rfc822("g2@faux-gmail.test"), COMPTE, encode)).status).toBe(503);
    expect((await envoyerBrut(rfc822("g3@faux-gmail.test"), "vrai-jeton", encode)).status).toBe(401);
    await controle("quota");
    expect((await envoyerBrut(rfc822("g4@faux-gmail.test"), COMPTE, "/%67mail/v1/users/me/messages")).status).not.toBe(200);
    expect((await fetch(`${gmail.url}/%67mail/v1/users/me/messages`)).status).toBe(401);
  });

  it("[C-592] attaque : /__controle refusé si NODE_ENV=production, serveur sur 127.0.0.1", async () => {
    expect(gmail.adresse).toBe("127.0.0.1");
    const avant = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect((await controle("panne_generale")).status).toBe(403);
    } finally {
      process.env["NODE_ENV"] = avant;
    }
  });

  it("[C-592] le message remis est celui qui a été envoyé : Cci invisible, Cc distincts, pièce jointe et fil conservés", async () => {
    const puits = await demarrerPuitsSmtp();
    const local = await demarrerFauxGmail({ mailpit: puits.client });
    try {
      const frontiere = "limite-test";
      const message = [
        "Message-ID: <fil-2@faux-gmail.test>",
        "From: lemoine@exemple.fr",
        "To: client@exemple.fr",
        "Cc: copie@exemple.fr",
        "Bcc: cache@exemple.fr",
        "In-Reply-To: <fil-1@faux-gmail.test>",
        "References: <fil-1@faux-gmail.test>",
        "Reply-To: reponses@exemple.fr",
        "Subject: Relance",
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${frontiere}"`,
        "",
        `--${frontiere}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Bonjour",
        `--${frontiere}`,
        'Content-Type: text/plain; name="devis.txt"',
        'Content-Disposition: attachment; filename="devis.txt"',
        "",
        "contenu-de-la-piece",
        `--${frontiere}--`,
        "",
      ].join("\r\n");
      const r = await fetch(`${local.url}/gmail/v1/users/me/messages/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${COMPTE}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: Buffer.from(message).toString("base64url") }),
      });
      expect(r.status).toBe(200);
      expect(puits.depots).toHaveLength(1);
      const depot = puits.depots[0] as Depot;
      expect(depot.pour.sort()).toEqual(["cache@exemple.fr", "client@exemple.fr", "copie@exemple.fr"]);
      const [entetes = ""] = depot.donnees.split("\r\n\r\n");
      expect(entetes.toLowerCase()).not.toContain("bcc:");
      expect(entetes).not.toContain("cache@exemple.fr");
      expect(entetes).toContain("To: client@exemple.fr");
      expect(entetes).toContain("Cc: copie@exemple.fr");
      expect(entetes).toContain("In-Reply-To: <fil-1@faux-gmail.test>");
      expect(entetes).toContain("References: <fil-1@faux-gmail.test>");
      expect(entetes).toContain("Reply-To: reponses@exemple.fr");
      expect(depot.donnees).toContain("contenu-de-la-piece");
    } finally {
      await local.arreter();
      await puits.arreter();
    }
  });
});
