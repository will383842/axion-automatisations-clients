import { createServer as serveurTls, type Server } from "node:tls";
import type { Duplex } from "node:stream";
import { authentifier, decoderPlain, ouvrirDepuisJeton, reponsePlain, secretsDe, type PortsMandataire } from "./authentifier.js";
import type { OptionsEcoute } from "./imap.js";
import { ErreurMandataire, Lecteur, ligneJournal, relayer, type CodeFin } from "./relayer.js";

// Mandataire SMTP (T4-41) : écoute en TLS sur le réseau interne ; connexion sortante en TLS implicite (SMTPS), AUTH PLAIN en deux temps composé ici seul.
const ECHEC = "535 5.7.8 Authentification refusee";

// Lit une réponse SMTP (lignes « 250-… » puis « 250 … ») et rend son code ; refuse tout code absent ou mal formé.
async function reponse(s: Lecteur): Promise<number> {
  for (;;) {
    const ligne = await s.ligne(10_000);
    const m = ligne === null ? null : /^(\d{3})([ -])/.exec(ligne);
    if (!m) throw new ErreurMandataire("indisponible");
    if (m[2] === " ") return Number(m[1]);
  }
}

export async function servirSmtp(client: Duplex, p: PortsMandataire): Promise<void> {
  const debut = p.maintenant();
  let instanceId: string | undefined;
  let hote: string | undefined;
  let volume = 0;
  let code: CodeFin = "refuse";
  client.on("error", () => undefined);
  const l = new Lecteur(client);
  const dire = (s: string) => client.write(s);
  try {
    dire("220 mandataire pret\r\n");
    let portee;
    for (let essais = 0; !portee && essais < 5; essais++) {
      const ligne = await l.ligne();
      if (ligne === null) return;
      const m = /^([A-Za-z]{4})(?: (.*))?$/.exec(ligne);
      const verbe = m?.[1]?.toUpperCase();
      if (verbe === "EHLO") dire("250-mandataire\r\n250 AUTH PLAIN\r\n");
      else if (verbe === "HELO") dire("250 mandataire\r\n");
      else if (verbe === "NOOP") dire("250 ok\r\n");
      else if (verbe === "QUIT") return void dire("221 au revoir\r\n");
      else if (verbe === "AUTH") {
        const [meca, ir] = (m?.[2] ?? "").split(" ") as [string, string | undefined];
        let rep = ir;
        if (meca?.toUpperCase() === "PLAIN" && rep === undefined) {
          dire("334 \r\n");
          rep = (await l.ligne()) ?? "";
        }
        const id = meca?.toUpperCase() === "PLAIN" && rep !== undefined ? decoderPlain(rep) : null;
        portee = id ? authentifier(p, id.utilisateur, id.jeton) : null;
        if (!portee) return void (code = "refuse", dire(`${ECHEC}\r\n`));
      } else dire("530 5.7.0 Authentification requise\r\n");
    }
    if (!portee) return void dire("421 trop d'essais\r\n");
    instanceId = portee.instanceId;

    const { connexion, motDePasse } = await ouvrirDepuisJeton(p, portee);
    hote = connexion.hote;
    const serveur = await p.ouvrir({ hote: connexion.hote, port: connexion.port });
    serveur.on("error", () => undefined);
    const s = new Lecteur(serveur, 65_536);
    try {
      if ((await reponse(s)) !== 220) throw new ErreurMandataire("indisponible");
      serveur.write("EHLO mandataire.interne\r\n");
      if ((await reponse(s)) !== 250) throw new ErreurMandataire("indisponible");
      serveur.write("AUTH PLAIN\r\n");
      if ((await reponse(s)) !== 334) throw new ErreurMandataire("identification");
      serveur.write(`${reponsePlain(connexion.identifiant, motDePasse)}\r\n`);
      if ((await reponse(s)) !== 235) throw new ErreurMandataire("identification");
    } catch (e) {
      serveur.destroy();
      throw e;
    }
    dire("235 2.7.0 Authentification reussie\r\n");
    const r = await relayer(client, serveur, { protocole: "smtp", secrets: secretsDe(connexion.identifiant, motDePasse), deClient: l.detacher(), deServeur: s.detacher() });
    volume = r.octets;
    code = r.code;
  } catch (e) {
    code = e instanceof ErreurMandataire ? e.code : "indisponible";
    if (!client.destroyed) dire(`${ECHEC}\r\n`);
  } finally {
    p.journaliser(ligneJournal({ instanceId, hote, dureeMs: p.maintenant() - debut, octets: volume, code }));
    if (!client.destroyed) client.end();
  }
}

export function ecouterSmtp(p: PortsMandataire, o: OptionsEcoute): Server {
  const srv = serveurTls({ key: o.cle, cert: o.certificat, minVersion: "TLSv1.2" }, (s) => void servirSmtp(s, p));
  srv.listen(o.port, o.hote ?? "127.0.0.1");
  return srv;
}
