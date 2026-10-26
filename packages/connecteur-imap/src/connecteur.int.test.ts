import { execFileSync } from "node:child_process";
import { creerJeton } from "@axion-auto/connecteurs-commun";
import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";
import { ouvrirConnecteur } from "./connecteur.ts";
import { ouvrirSessionImap } from "./imap.ts";
import { envoyerSmtp } from "./smtp.ts";
import { verifierConfiguration } from "./verification.ts";

// Tests contre le GreenMail du socle lancé par ops/socle/lancer.sh (job socle-integration).
// Le réseau « interne » n'ouvre aucun port : depuis l'hôte Linux, on joint l'adresse du conteneur lue avec docker inspect.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const adresse = () => {
  const id = docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=greenmail");
  return docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
};

// GreenMail crée l'utilisateur à la première livraison, identifiant et mot de passe égaux à l'adresse.
const COMPTE = "essai@exemple.fr";
const CERTIFICAT_DE_TEST = { rejectUnauthorized: false } as const;

describe("connecteur IMAP/SMTP contre GreenMail", () => {
  it("[A-389] envoi puis lecture d'un message par GreenMail (intégration)", async () => {
    const hote = adresse();
    await createTransport({ host: hote, port: 3465, secure: true, tls: CERTIFICAT_DE_TEST }).sendMail({ from: "amorce@exemple.fr", to: COMPTE, subject: "Amorce", text: "Crée la boîte" });

    const config = verifierConfiguration({ hoteImap: "greenmail.test", hoteSmtp: "greenmail.test", utilisateur: COMPTE, expediteur: COMPTE });
    const jeton = creerJeton(COMPTE, Date.now() + 60_000);
    const connecteur = await ouvrirConnecteur(config, jeton, {
      tls: CERTIFICAT_DE_TEST,
      ouvrirImap: (o) => ouvrirSessionImap({ ...o, host: hote, port: 3993 }),
      envoyerSmtp: (o, m, e) => envoyerSmtp({ ...o, host: hote, port: 3465 }, m, e),
    });

    await connecteur.envoyer(jeton, { messageId: "<essai-1.int@exemple.fr>", destinataire: COMPTE, objet: "Bonjour GreenMail", corps: "Texte d'essai" });

    const page = await connecteur.listerNouveaux(jeton, null);
    const lus = await Promise.all(page.ids.map((id) => connecteur.lire(jeton, id, ["objet", "corps"])));
    expect(lus.map((m) => m.objet)).toContain("Bonjour GreenMail");
  }, 60_000);
});
