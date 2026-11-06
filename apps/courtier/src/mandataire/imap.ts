import { createServer as serveurTls, type Server } from "node:tls";
import type { Duplex } from "node:stream";
import { authentifier, decoderPlain, ouvrirDepuisJeton, reponsePlain, secretsDe, type PortsMandataire } from "./authentifier.js";
import { ErreurMandataire, Lecteur, ligneJournal, relayer, type CodeFin } from "./relayer.js";

// Mandataire IMAP (T4-41) : écoute en TLS sur le réseau interne ; connexion sortante en TLS implicite (IMAPS), donc la liste des capacités
// annoncée par le serveur réel est lue APRÈS l'établissement du TLS. L'authentification sortante est composée ici seul (AUTHENTICATE PLAIN
// en deux temps : le mot de passe voyage en base64, aucune injection de commande possible).
const TAG = /^[A-Za-z0-9]{1,32}$/;
const ECHEC = "NO [AUTHENTICATIONFAILED] Authentication failed";

export async function servirImap(client: Duplex, p: PortsMandataire): Promise<void> {
  const debut = p.maintenant();
  let instanceId: string | undefined;
  let hote: string | undefined;
  let volume = 0;
  let code: CodeFin = "refuse";
  let tag = "";
  client.on("error", () => undefined);
  const l = new Lecteur(client);
  const dire = (s: string) => client.write(s);
  try {
    dire("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] mandataire pret\r\n");
    let portee;
    for (let essais = 0; !portee && essais < 5; essais++) {
      const ligne = await l.ligne();
      if (ligne === null) return;
      const m = /^(\S+) ([A-Za-z]+)(?: (.*))?$/.exec(ligne);
      if (!m || !TAG.test(m[1]!)) {
        dire("* BYE commande invalide\r\n");
        return;
      }
      tag = m[1]!;
      const verbe = m[2]!.toUpperCase();
      const reste = m[3] ?? "";
      if (verbe === "CAPABILITY") dire(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK fait\r\n`);
      else if (verbe === "NOOP") dire(`${tag} OK fait\r\n`);
      else if (verbe === "LOGOUT") return void dire(`* BYE au revoir\r\n${tag} OK fait\r\n`);
      else if (verbe === "AUTHENTICATE" || verbe === "LOGIN") {
        let id: { utilisateur: string; jeton: string } | null = null;
        if (verbe === "AUTHENTICATE") {
          const [meca, ir] = reste.split(" ") as [string, string | undefined];
          let reponse = ir;
          if (meca?.toUpperCase() === "PLAIN" && reponse === undefined) {
            dire("+ \r\n");
            reponse = (await l.ligne()) ?? "";
          }
          id = meca?.toUpperCase() === "PLAIN" && reponse !== undefined ? decoderPlain(reponse) : null;
        } else {
          // LOGIN : deux mots simples ou deux chaînes entre guillemets sans antislash ; aucun littéral.
          const a = /^(?:"([^"\\\r\n]*)"|([^\s"{}\\]+)) (?:"([^"\\\r\n]*)"|([^\s"{}\\]+))$/.exec(reste);
          id = a ? { utilisateur: a[1] ?? a[2] ?? "", jeton: a[3] ?? a[4] ?? "" } : null;
        }
        portee = id ? authentifier(p, id.utilisateur, id.jeton, "messagerie.lecture") : null;
        if (!portee) return void (code = "refuse", dire(`${tag} ${ECHEC}\r\n`));
      } else dire(`${tag} BAD authentification requise\r\n`);
    }
    if (!portee) return void dire(`* BYE trop d'essais\r\n`);
    instanceId = portee.instanceId;

    const { connexion, motDePasse } = await ouvrirDepuisJeton(p, portee);
    hote = connexion.hote;
    const serveur = await p.ouvrir({ hote: connexion.hote, port: connexion.port });
    serveur.on("error", () => undefined);
    const s = new Lecteur(serveur, 65_536);
    try {
      const accueil = await s.ligne(10_000);
      if (accueil === null || !accueil.startsWith("* OK")) throw new ErreurMandataire("indisponible");
      // Capacités lues APRÈS l'établissement du TLS sortant (elles diffèrent parfois d'avant le TLS).
      serveur.write("m0 CAPABILITY\r\n");
      let capacites = "";
      for (let ligne = await s.ligne(10_000); !ligne?.startsWith("m0 "); ligne = await s.ligne(10_000)) {
        if (ligne === null) throw new ErreurMandataire("indisponible");
        if (/^\* CAPABILITY /i.test(ligne)) capacites = ligne.toUpperCase();
      }
      if (capacites.includes("AUTH=PLAIN")) {
        serveur.write("m1 AUTHENTICATE PLAIN\r\n");
        for (let ligne = await s.ligne(10_000); !ligne?.startsWith("+"); ligne = await s.ligne(10_000)) if (ligne === null || ligne.startsWith("m1 ")) throw new ErreurMandataire("identification");
        serveur.write(`${reponsePlain(connexion.identifiant, motDePasse)}\r\n`);
      } else if (!capacites.includes("LOGINDISABLED")) {
        // Repli LOGIN : chaînes entre guillemets, ASCII imprimable sans guillemet ni antislash, sinon refus (aucune injection possible).
        const sur = (v: string) => /^[\x20-\x7e]+$/.test(v) && !/["\\]/.test(v);
        if (!sur(connexion.identifiant) || !sur(motDePasse)) throw new ErreurMandataire("indisponible");
        serveur.write(`m1 LOGIN "${connexion.identifiant}" "${motDePasse}"\r\n`);
      } else throw new ErreurMandataire("identification");
      let fin = await s.ligne(10_000);
      while (fin !== null && !fin.startsWith("m1 ")) fin = await s.ligne(10_000);
      if (fin === null || !/^m1 OK\b/i.test(fin)) throw new ErreurMandataire("identification");
    } catch (e) {
      serveur.destroy();
      throw e;
    }
    dire(`${tag} OK [CAPABILITY IMAP4rev1] Authentication successful\r\n`);
    const r = await relayer(client, serveur, { protocole: "imap", secrets: secretsDe(connexion.identifiant, motDePasse), deClient: l.detacher(), deServeur: s.detacher() });
    volume = r.octets;
    code = r.code;
  } catch (e) {
    code = e instanceof ErreurMandataire ? e.code : "indisponible";
    // Réponse identique quelle que soit la cause : l'exécuteur ne voit ni le certificat, ni le serveur, ni un texte du serveur réel.
    if (!client.destroyed) dire(`${tag || "*"} ${ECHEC}\r\n`);
  } finally {
    p.journaliser(ligneJournal({ instanceId, hote, dureeMs: p.maintenant() - debut, octets: volume, code }));
    if (!client.destroyed) client.end();
  }
}

export interface OptionsEcoute { cle: string; certificat: string; port: number; hote?: string }
// Écoute en TLS (certificat du mandataire lu par l'appelant, jamais dans le dépôt). À lier à l'adresse du réseau interne.
export function ecouterImap(p: PortsMandataire, o: OptionsEcoute): Server {
  const srv = serveurTls({ key: o.cle, cert: o.certificat, minVersion: "TLSv1.2" }, (s) => void servirImap(s, p));
  srv.listen(o.port, o.hote ?? "127.0.0.1");
  return srv;
}
