import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ouvrirSessionImap } from "./imap.ts";
import { optionsImap, verifierConfiguration } from "./verification.ts";

let serveur: Server | undefined;
afterEach(() => new Promise<void>((ok) => (serveur ? serveur.close(() => ok()) : ok())));

// Faux serveur IMAP local, sans TLS : annonce ses capacités sans STARTTLS et note toute tentative d'identification.
async function serveurEnClair(): Promise<{ port: number; commandes: string[] }> {
  const commandes: string[] = [];
  serveur = createServer((s) => {
    s.write("* OK [CAPABILITY IMAP4rev1] essai pret\r\n");
    s.on("data", (d) => {
      for (const l of String(d).split("\r\n").filter(Boolean)) {
        commandes.push(l);
        const [tag = "", verbe = ""] = l.split(" ");
        if (/^CAPABILITY/i.test(verbe)) s.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK fait\r\n`);
        else if (/^LOGOUT/i.test(verbe)) s.end(`* BYE\r\n${tag} OK fait\r\n`);
        else s.write(`${tag} NO refuse\r\n`);
      }
    });
    s.on("error", () => undefined);
  });
  await new Promise<void>((ok) => serveur?.listen(0, "127.0.0.1", ok));
  return { port: (serveur.address() as { port: number }).port, commandes };
}

describe("IMAP sans repli en clair", () => {
  it("[A-389] un serveur sans TLS est refusé : aucun identifiant n'est envoyé", async () => {
    const { port, commandes } = await serveurEnClair();
    const c = verifierConfiguration({ hoteImap: "127.0.0.1", hoteSmtp: "127.0.0.1", portImap: 143, chiffrementImap: "starttls", utilisateur: "instance-essai", expediteur: "atelier@exemple.fr" });
    await expect(ouvrirSessionImap({ ...optionsImap(c, "jeton-fictif"), port })).rejects.toBeTruthy();
    expect(commandes.some((l) => /\b(LOGIN|AUTHENTICATE)\b/i.test(l))).toBe(false);
  });
});
