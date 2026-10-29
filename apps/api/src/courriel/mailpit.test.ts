import { createServer } from "node:net";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit } from "../../../../packages/harnais/src/mailpit.js";
import { TABLE_ENVOIS, type Envoi } from "../../../../packages/contrats/src/notifications/table.js";
import { creerExpediteur } from "./expediteur.js";
import { creerTransportMailpit } from "./mailpit.js";

const ORANGE: Envoi = { evenement: "alerteOrange", destinataire: "will", canal: "email", mode: "automatique", interrupteur: "envoi.alerteOrange", cleTexte: null, version: "V1", exigence: "B-394" };

// Le service Mailpit n'existe que dans le job « harnais » (aucun job n'y lance encore apps/api) : sans MAILPIT_API, ces essais sont sautés.
const itMailpit = process.env["MAILPIT_API"] ? it : it.skip; // fiche: T0-20

// Faux serveur SMTP local : il enregistre les commandes reçues, pour essayer le transport sans Mailpit.
async function fauxSmtp(refuserRcpt = false) {
  const commandes: string[] = [];
  let donnees = "";
  const serveur = createServer((s) => {
    let enDonnees = false;
    let tampon = "";
    s.write("220 faux\r\n");
    s.on("data", (b) => {
      tampon += b.toString("utf8");
      for (let i = tampon.indexOf("\r\n"); i >= 0; i = tampon.indexOf("\r\n")) {
        const ligne = tampon.slice(0, i);
        tampon = tampon.slice(i + 2);
        if (enDonnees) {
          if (ligne === ".") { enDonnees = false; s.write("250 ok\r\n"); } else donnees += `${ligne}\n`;
          continue;
        }
        commandes.push(ligne);
        if (ligne.startsWith("EHLO")) s.write("250-faux\r\n250 8BITMIME\r\n");
        else if (ligne === "DATA") { enDonnees = true; s.write("354 go\r\n"); }
        else if (ligne === "QUIT") s.end("221 bye\r\n");
        else if (ligne.startsWith("RCPT") && refuserRcpt) s.write("550 non\r\n");
        else s.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const port = (serveur.address() as { port: number }).port;
  return { commandes, donnees: () => donnees, port, fermer: () => new Promise((ok) => serveur.close(ok)) };
}

describe("transport Mailpit (faux serveur SMTP local)", () => {
  it("[B-394] le message part avec le bon expéditeur, le bon destinataire et un corps en base64", async () => {
    const faux = await fauxSmtp();
    await creerTransportMailpit({ de: "service@exemple.fr", smtp: { host: "127.0.0.1", port: faux.port } }).envoyer({ a: "equipe@exemple.fr", sujet: "Alerte orange · Garage Fontaine", texte: "Client : Garage Fontaine\n" });
    await faux.fermer();
    expect(faux.commandes).toEqual(expect.arrayContaining(["MAIL FROM:<service@exemple.fr>", "RCPT TO:<equipe@exemple.fr>", "DATA", "QUIT"]));
    expect(faux.donnees()).toContain("To: equipe@exemple.fr");
    expect(Buffer.from(faux.donnees().split("\n\n")[1]!.replace(/\s/g, ""), "base64").toString("utf8")).toContain("Garage Fontaine");
  });

  it("[B-394] un refus du serveur fait échouer l'envoi", async () => {
    const faux = await fauxSmtp(true);
    await expect(creerTransportMailpit({ de: "service@exemple.fr", smtp: { host: "127.0.0.1", port: faux.port } }).envoyer({ a: "equipe@exemple.fr", sujet: "s", texte: "t" })).rejects.toThrow();
    await faux.fermer();
  });

  it("[B-394] un hôte non local est refusé", () => {
    expect(() => creerTransportMailpit({ de: "service@exemple.fr", smtp: { host: "smtp.exemple.fr", port: 25 } })).toThrow();
  });
});

describe("expéditeur → Mailpit (job harnais)", () => {
  const mailpit = creerClientMailpit();
  beforeAll(() => (process.env["MAILPIT_API"] ? mailpit.attendrePret() : undefined));
  beforeEach(() => (process.env["MAILPIT_API"] ? mailpit.vider() : undefined));

  const monter = (ouvert: boolean) =>
    creerExpediteur({ table: [...TABLE_ENVOIS, ORANGE], transport: creerTransportMailpit({ de: "service@exemple.fr", smtp: mailpit.smtp }), interrupteurs: { ouvert: () => ouvert }, trace: { ecrire: () => {} } });

  itMailpit("[B-394] orange → Mailpit reçoit un e-mail qui ne porte que client, automatisation et code d'erreur", async () => {
    await monter(true).envoyer("alerteOrange", { role: "will", adresse: "equipe@exemple.fr" }, { client: "Garage Fontaine", automatisation: "Relance des devis", codeErreur: "E-CONNEXION-401" });
    const [resume] = await mailpit.attendreMessages(1);
    const message = await mailpit.lire(resume!.ID);
    expect(message.To[0]?.Address).toBe("equipe@exemple.fr");
    expect(message.Subject).toContain("Garage Fontaine");
    expect(message.Text).toContain("Relance des devis");
    expect(message.Text).toContain("E-CONNEXION-401");
  });

  itMailpit("[A-116] interrupteur fermé → Mailpit ne reçoit rien", async () => {
    await monter(false).envoyer("alerteOrange", { role: "will", adresse: "equipe@exemple.fr" }, { client: "Garage Fontaine", automatisation: "Relance des devis", codeErreur: "E-1" });
    await new Promise((ok) => setTimeout(ok, 500));
    expect(await mailpit.lister()).toHaveLength(0);
  });
});
