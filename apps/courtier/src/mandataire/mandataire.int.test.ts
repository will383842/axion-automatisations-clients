import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { ouvrirConnecteur } from "../../../../packages/connecteur-imap/src/connecteur.ts";
import { ouvrirSessionImap } from "../../../../packages/connecteur-imap/src/imap.ts";
import { envoyerSmtp } from "../../../../packages/connecteur-imap/src/smtp.ts";
import { verifierConfiguration } from "../../../../packages/connecteur-imap/src/verification.ts";
import { creerJeton } from "../../../../packages/connecteurs-commun/src/jeton.ts";
import { journalEchecs } from "../../../api/src/provisionnement/journal-echecs.ts";
import { creerRegistreJetons } from "../jetons.ts";
import type { PortsMandataire } from "./authentifier.ts";
import { ecouterImap } from "./imap.ts";
import { ouvrirTlsVerifie, ErreurMandataire } from "./relayer.ts";
import { ecouterSmtp } from "./smtp.ts";

// Tests contre le GreenMail du socle lancé par ops/socle/lancer.sh (job socle-integration), comme packages/connecteur-imap.
// Le certificat de GreenMail est un certificat de test auto-signé : la vérification n'est coupée QUE dans ces essais, pour le seul lien mandataire → GreenMail.
// Les échecs sont écrits par writeSync(2, …) : le rapport JSON de la CI n'est pas publié (règle des routines).
journalEchecs(import.meta.url);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const adresse = () => {
  const id = docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=greenmail");
  return docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
};
const COMPTE = "essai@exemple.fr";
const INSTANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const CONNEXION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXECUTION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const traces: string[] = [];
const fermer: (() => void)[] = [];
afterAll(() => void fermer.forEach((f) => f()));

function ports(hote: string, port: number, verifie: boolean): { p: PortsMandataire; jeton: string; journal: string[] } {
  const jetons = creerRegistreJetons();
  const journal: string[] = [];
  const p: PortsMandataire = {
    jetons,
    connexion: async (i, c) => (i === INSTANCE && c === CONNEXION ? { tenantId: CLIENT, instanceId: INSTANCE, connexionId: CONNEXION, hote, port, identifiant: COMPTE, referenceCoffre: `bao:clients/${CLIENT}/messagerie` } : undefined),
    // GreenMail : mot de passe = adresse du compte.
    lireMotDePasse: async () => COMPTE,
    ouvrir: async (cible) => {
      const s = await (verifie ? ouvrirTlsVerifie(cible) : ouvrirTlsVerifie(cible, ((o: Record<string, unknown>) => tlsConnect({ ...o, rejectUnauthorized: false })) as never));
      // Diagnostic de CI : ce que dit le serveur de test (GreenMail, mot de passe fictif), première ligne de chaque paquet.
      s.on("data", (b: Buffer) => traces.push(`${cible.port} <- ${b.toString("latin1").split("\r\n")[0]!.slice(0, 160)}`));
      return s;
    },
    journaliser: (l) => void journal.push(l),
    maintenant: Date.now,
  };
  const { jeton } = jetons.emettre({ tenantId: CLIENT, instanceId: INSTANCE, connexionId: CONNEXION, executionId: EXECUTION, portees: ["messagerie.lecture", "messagerie.envoi"] }, 60_000);
  return { p, jeton, journal };
}

describe("mandataire contre GreenMail", () => {
  it("[A-335] le connecteur IMAP de T4-12 lit et envoie par le mandataire contre GreenMail", async () => {
    const hote = adresse();
    // certificat du mandataire : fabriqué à la volée, jamais écrit dans le dépôt
    const dossier = mkdtempSync(join(tmpdir(), "mandataire-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dossier, "k.pem"), "-out", join(dossier, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    const cle = readFileSync(join(dossier, "k.pem"), "utf8");
    const certificat = readFileSync(join(dossier, "c.pem"), "utf8");
    // amorce : GreenMail crée la boîte à la première livraison
    await envoyerSmtp({ host: hote, port: 3465, secure: true, requireTLS: false, ignoreTLS: false, auth: undefined as never, tls: { rejectUnauthorized: false } as never }, { messageId: "<amorce.int@exemple.fr>", destinataire: COMPTE, objet: "Amorce", corps: "Crée la boîte" }, "amorce@exemple.fr");

    const imap = ports(hote, 3993, false);
    const smtp = ports(hote, 3465, false);
    const srvImap = ecouterImap(imap.p, { cle, certificat, port: 0 });
    const srvSmtp = ecouterSmtp(smtp.p, { cle, certificat, port: 0 });
    fermer.push(() => (srvImap.close(), srvSmtp.close()));
    await Promise.all([new Promise((r) => srvImap.once("listening", r)), new Promise((r) => srvSmtp.once("listening", r))]);
    const portImap = (srvImap.address() as { port: number }).port;
    const portSmtp = (srvSmtp.address() as { port: number }).port;

    try {
      const config = verifierConfiguration({ hoteImap: "mandataire.test", hoteSmtp: "mandataire.test", utilisateur: INSTANCE, expediteur: COMPTE });
      const jetonImap = creerJeton(imap.jeton, Date.now() + 60_000);
      const jetonSmtp = creerJeton(smtp.jeton, Date.now() + 60_000);
      const connecteur = await ouvrirConnecteur(config, jetonImap, {
        tls: { rejectUnauthorized: false },
        ouvrirImap: (o) => ouvrirSessionImap({ ...o, host: "127.0.0.1", port: portImap }),
        envoyerSmtp: (o, m, e) => envoyerSmtp({ ...o, host: "127.0.0.1", port: portSmtp }, m, e),
      });
      await connecteur.envoyer(jetonSmtp, { messageId: "<essai-mandataire.int@exemple.fr>", destinataire: COMPTE, objet: "Bonjour par le mandataire", corps: "Texte d'essai" });
      const page = await connecteur.listerNouveaux(jetonImap, null);
      const lus = await Promise.all(page.ids.map((id) => connecteur.lire(jetonImap, id, ["objet", "corps"])));
      expect(lus.map((m) => m.objet)).toContain("Bonjour par le mandataire");
      expect(imap.journal.join("\n")).not.toContain(COMPTE);
    } catch (e) {
      writeSync(2, `DIAG mandataire ${[...traces, ...imap.journal, ...smtp.journal].join(" | ")}\n`);
      throw e;
    }
  }, 90_000);

  it("[A-389] certificat du serveur du client invalide : connexion refusée, classe identification", async () => {
    // GreenMail présente un certificat auto-signé : avec la vérification complète du mandataire, la connexion sortante est refusée.
    const hote = adresse();
    const e = await ouvrirTlsVerifie({ hote, port: 3993 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurMandataire);
    expect((e as ErreurMandataire).code).toBe("identification");
  }, 30_000);
});
