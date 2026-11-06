import { createServer, connect, type Server, type Socket } from "node:net";
import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { creerRegistreJetons } from "../jetons.ts";
import { type ConnexionMessagerie, type PortsMandataire } from "./authentifier.ts";
import { servirImap } from "./imap.ts";
import { FiltreCommandes, Masqueur, ErreurMandataire, ouvrirTlsVerifie } from "./relayer.ts";
import { servirSmtp } from "./smtp.ts";

const INST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const CONN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONN_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EXEC = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MDP_A = "Mdp-App-Essai-93kd-A";
const MDP_B = "Mdp-App-Essai-71xz-B";
const MARQUEUR = "CONTENU-MARQUEUR-5b21";

const fermer: (() => void)[] = [];
afterEach(() => void fermer.splice(0).forEach((f) => f()));

// Faux serveur « réel » (IMAP ou SMTP) en clair : l'essai ne prouve pas le TLS, il est prouvé à part sur les options.
async function fauxServeur(protocole: "imap" | "smtp", mdp: string, identifiant: string) {
  const recu: string[] = [];
  const octets: Buffer[] = [];
  const srv = createServer((s) => {
    s.write(protocole === "imap" ? "* OK pret\r\n" : "220 reel pret\r\n");
    let tampon = "";
    let etat: "" | "plain" = "";
    let tag = "";
    let data = false;
    s.on("data", (b: Buffer) => {
      octets.push(b);
      tampon += b.toString("latin1");
      for (let i; (i = tampon.indexOf("\r\n")) >= 0; ) {
        const l = tampon.slice(0, i);
        tampon = tampon.slice(i + 2);
        recu.push(l);
        if (protocole === "smtp" && data) {
          if (l === ".") (data = false), s.write("250 2.0.0 accepte\r\n");
          continue;
        }
        if (etat === "plain") {
          etat = "";
          const bon = Buffer.from(l, "base64").toString("latin1") === `\0${identifiant}\0${mdp}`;
          s.write(protocole === "imap" ? `${tag} ${bon ? "OK connecte" : "NO [AUTHENTICATIONFAILED] refuse"}\r\n` : bon ? "235 2.7.0 ok\r\n" : "535 refuse\r\n");
        } else if (protocole === "imap") {
          const m = /^(\S+) (\S+)/.exec(l);
          if (!m) continue;
          tag = m[1]!;
          if (m[2] === "AUTHENTICATE") (etat = "plain"), s.write("+ \r\n");
          else if (m[2] === "SELECT") s.write(`* 3 EXISTS\r\n${tag} OK [READ-WRITE] fait\r\n`);
          else if (m[2] === "LOGOUT") s.write(`* BYE\r\n${tag} OK\r\n`), s.end();
          else if (m[2] === "LOGIN") s.write(`${tag} OK login accepte\r\n`);
          else s.write(`${tag} BAD commande inconnue, la session de ${identifiant} avec ${mdp} est refusee\r\n`);
        } else if (l.startsWith("EHLO")) s.write("250-reel\r\n250 AUTH PLAIN\r\n");
        else if (l.startsWith("AUTH PLAIN")) (etat = "plain"), s.write("334 \r\n");
        else if (l === "DATA") (data = true), s.write("354 go\r\n");
        else if (l.startsWith("QUIT")) s.write("221 bye\r\n"), s.end();
        else s.write(`250 ok ${l.startsWith("MAIL") ? mdp : ""}\r\n`);
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  fermer.push(() => srv.close());
  return { port: (srv.address() as { port: number }).port, recu, octets };
}

function monter(protocole: "imap" | "smtp", reels: Record<string, number>) {
  const jetons = creerRegistreJetons();
  const connexions: Record<string, ConnexionMessagerie> = {
    [`${INST_A}|${CONN_A}`]: { tenantId: CLIENT_A, instanceId: INST_A, connexionId: CONN_A, hote: "serveur-a.exemple.test", port: 993, identifiant: "essai-a@exemple.fr", referenceCoffre: `bao:clients/${CLIENT_A}/messagerie` },
    [`${INST_B}|${CONN_B}`]: { tenantId: CLIENT_B, instanceId: INST_B, connexionId: CONN_B, hote: "serveur-b.exemple.test", port: 993, identifiant: "essai-b@exemple.fr", referenceCoffre: `bao:clients/${CLIENT_B}/messagerie` },
  };
  const ouvertures: { hote: string; port: number }[] = [];
  const journal: string[] = [];
  let t = 1_000_000;
  const p: PortsMandataire = {
    jetons,
    connexion: async (i, c) => connexions[`${i}|${c}`],
    lireMotDePasse: async (c) => (c.tenantId === CLIENT_A ? MDP_A : MDP_B),
    ouvrir: async (cible) => {
      ouvertures.push(cible);
      const s = connect(reels[cible.hote]!, "127.0.0.1");
      await once(s, "connect");
      return s;
    },
    journaliser: (l) => void journal.push(l),
    maintenant: () => (t += 5),
  };
  const jeton = (inst: string, conn: string, tenant: string) => jetons.emettre({ tenantId: tenant, instanceId: inst, connexionId: conn, executionId: EXEC, portees: ["messagerie"] }, 60_000).jeton;
  const serveur: Server = createServer((s) => void (protocole === "imap" ? servirImap(s, p) : servirSmtp(s, p)));
  fermer.push(() => serveur.close());
  return { p, jetons, jeton, ouvertures, journal, ecouter: async () => (await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", r)), (serveur.address() as { port: number }).port) };
}

// Client d'essai : écrit des lignes, attend un motif, garde tous les octets reçus.
async function client(port: number) {
  const s: Socket = connect(port, "127.0.0.1");
  fermer.push(() => s.destroy());
  let recu = "";
  s.on("data", (b) => (recu += b.toString("latin1")));
  s.on("error", () => undefined);
  await once(s, "connect");
  const attendre = async (motif: RegExp, ms = 2000) => {
    const fin = Date.now() + ms;
    while (!motif.test(recu)) {
      if (Date.now() > fin) throw new Error(`motif absent: ${motif} dans ${JSON.stringify(recu)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const plain = (u: string, m: string) => Buffer.from(`\0${u}\0${m}`).toString("base64");
  return { s, attendre, envoyer: (x: string) => s.write(x), tout: () => recu, ferme: () => s.destroyed || s.writableEnded };
}

describe("mandataire IMAP/SMTP du courtier", () => {
  it("[A-335] lit par le mandataire contre un faux serveur IMAP : le serveur reçoit l'authentification composée par le mandataire", async () => {
    const reel = await fauxServeur("imap", MDP_A, "essai-a@exemple.fr");
    const m = monter("imap", { "serveur-a.exemple.test": reel.port });
    const c = await client(await m.ecouter());
    await c.attendre(/\* OK/);
    c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${INST_A}\0${m.jeton(INST_A, CONN_A, CLIENT_A)}`).toString("base64")}\r\n`);
    await c.attendre(/a1 OK/);
    c.envoyer("a2 SELECT INBOX\r\n");
    await c.attendre(/a2 OK \[READ-WRITE\]/);
    expect(c.tout()).toContain("* 3 EXISTS");
    expect(reel.recu.some((l) => /^\S+ AUTHENTICATE PLAIN$/.test(l))).toBe(true);
    expect(m.ouvertures).toEqual([{ hote: "serveur-a.exemple.test", port: 993 }]);
  });

  it("[A-335] le mot de passe d'application n'apparaît dans aucun octet reçu par l'exécuteur (capture du flux)", async () => {
    const reel = await fauxServeur("imap", MDP_A, "essai-a@exemple.fr");
    const m = monter("imap", { "serveur-a.exemple.test": reel.port });
    const c = await client(await m.ecouter());
    c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${INST_A}\0${m.jeton(INST_A, CONN_A, CLIENT_A)}`).toString("base64")}\r\n`);
    await c.attendre(/a1 OK/);
    // le serveur réel recopie le mot de passe, en clair et en base64, dans un message d'erreur
    c.envoyer("a2 ZZZ\r\n");
    await c.attendre(/a2 BAD/);
    const tout = c.tout();
    expect(tout).not.toContain(MDP_A);
    expect(tout).not.toContain(Buffer.from(MDP_A).toString("base64"));
    expect(tout).not.toContain(Buffer.from(`\0essai-a@exemple.fr\0${MDP_A}`).toString("base64"));
    expect(m.journal.join("\n")).not.toContain(MDP_A);
  });

  it("[A-335] le mot de passe coupé entre deux paquets est masqué aussi", () => {
    const mq = new Masqueur([MDP_A]);
    const sortie = Buffer.concat([mq.pousser(Buffer.from(`a2 BAD ${MDP_A.slice(0, 7)}`)), mq.pousser(Buffer.from(`${MDP_A.slice(7)} fin\r\n`)), mq.fin()]).toString();
    expect(sortie).not.toContain(MDP_A);
    expect(sortie).not.toContain(MDP_A.slice(0, 7));
    expect(sortie).toContain("fin");
  });

  it("[A-335] @isolation le jeton de l'instance A ne donne pas accès à la boîte de B ; jeton inconnu, expiré ou d'une autre instance : refus identiques", async () => {
    const reelA = await fauxServeur("imap", MDP_A, "essai-a@exemple.fr");
    const reelB = await fauxServeur("imap", MDP_B, "essai-b@exemple.fr");
    const m = monter("imap", { "serveur-a.exemple.test": reelA.port, "serveur-b.exemple.test": reelB.port });
    const port = await m.ecouter();
    const jetonA = m.jeton(INST_A, CONN_A, CLIENT_A);
    const refus: string[] = [];
    for (const [u, j] of [
      [INST_B, jetonA], // jeton de A, identifiant d'instance de B
      [INST_A, "cj1_inconnu"],
      [INST_A, "x".repeat(500)],
      [INST_B, "cj1_inconnu"],
    ] as const) {
      const c = await client(port);
      c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${u}\0${j}`).toString("base64")}\r\n`);
      await c.attendre(/a1 NO/);
      refus.push(c.tout().replace(/^\* OK[^\r]*\r\n/, ""));
    }
    expect(new Set(refus).size).toBe(1);
    expect(m.ouvertures).toEqual([]);
    expect(reelB.recu).toEqual([]);
    // avec le bon couple, seule la boîte de A est visée
    const c = await client(port);
    c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${INST_A}\0${jetonA}`).toString("base64")}\r\n`);
    await c.attendre(/a1 OK/);
    c.envoyer(`a2 ID ("name" "x" "host" "serveur-b.exemple.test")\r\n`);
    await c.attendre(/a2 BAD/);
    expect(m.ouvertures).toEqual([{ hote: "serveur-a.exemple.test", port: 993 }]);
    expect(reelB.recu).toEqual([]);
  });

  it("[A-335] injection dans l'identifiant d'instance (saut de ligne, littéral) : refus, aucune connexion sortante", async () => {
    const reel = await fauxServeur("imap", MDP_A, "essai-a@exemple.fr");
    const m = monter("imap", { "serveur-a.exemple.test": reel.port });
    const port = await m.ecouter();
    const jeton = m.jeton(INST_A, CONN_A, CLIENT_A);
    for (const mauvais of [`${INST_A}\r\nb1 LOGIN x y`, `${INST_A} {5}`, `"${INST_A}"`, `${INST_A}\0autre`]) {
      const c = await client(port);
      c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${mauvais}\0${jeton}`).toString("base64")}\r\n`);
      await c.attendre(/a1 NO/);
    }
    // marque de commande piégée
    const c = await client(port);
    c.envoyer(`a1\r\nb2 LOGIN x y AUTHENTICATE PLAIN\r\n`);
    await c.attendre(/BAD|NO|BYE/);
    expect(m.ouvertures).toEqual([]);
    expect(reel.recu).toEqual([]);
  });

  it("[A-335] une seconde commande LOGIN ou AUTHENTICATE après l'authentification est refusée et jamais transmise", async () => {
    const reel = await fauxServeur("imap", MDP_A, "essai-a@exemple.fr");
    const m = monter("imap", { "serveur-a.exemple.test": reel.port });
    const c = await client(await m.ecouter());
    c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${INST_A}\0${m.jeton(INST_A, CONN_A, CLIENT_A)}`).toString("base64")}\r\n`);
    await c.attendre(/a1 OK/);
    const avant = reel.recu.length;
    c.envoyer(`a2 LOGIN autre@exemple.fr autre\r\n`);
    await c.attendre(/a2 (NO|BAD)|BYE/);
    await new Promise((r) => setTimeout(r, 50));
    expect(reel.recu.slice(avant).join("\n")).not.toMatch(/LOGIN|AUTHENTICATE|autre@/);
    expect(c.ferme() || /BYE/.test(c.tout())).toBe(true);
  });

  it("[A-335] le filtre suit les littéraux : une donnée qui ressemble à LOGIN passe, une commande LOGIN est refusée", () => {
    const f = new FiltreCommandes("imap");
    expect(f.pousser(Buffer.from("a3 APPEND INBOX {16}\r\na4 LOGIN x y\r\n\r\na5 NOOP\r\n")).refus).toBeUndefined();
    expect(new FiltreCommandes("imap").pousser(Buffer.from("a4 login x y\r\n")).refus).toBeDefined();
    expect(new FiltreCommandes("imap").pousser(Buffer.from("a4 AUTHENTICATE PLAIN\r\n")).refus).toBeDefined();
    expect(new FiltreCommandes("imap").pousser(Buffer.from("a4 STARTTLS\r\n")).refus).toBeDefined();
    // commande coupée en deux paquets
    const g = new FiltreCommandes("imap");
    expect(g.pousser(Buffer.from("a4 LOG")).refus).toBeUndefined();
    expect(g.pousser(Buffer.from("IN x y\r\n")).refus).toBeDefined();
    const s = new FiltreCommandes("smtp");
    expect(s.pousser(Buffer.from("MAIL FROM:<a@exemple.fr>\r\nDATA\r\nAUTH PLAIN xyz\r\n.\r\nNOOP\r\n")).refus).toBeUndefined();
    expect(new FiltreCommandes("smtp").pousser(Buffer.from("auth plain xyz\r\n")).refus).toBeDefined();
    expect(new FiltreCommandes("smtp").pousser(Buffer.from("STARTTLS\r\n")).refus).toBeDefined();
  });

  it("[A-335] SMTP : envoi par le mandataire, AUTH refusé après la première, mot de passe jamais reçu par l'exécuteur", async () => {
    const reel = await fauxServeur("smtp", MDP_A, "essai-a@exemple.fr");
    const m = monter("smtp", { "serveur-a.exemple.test": reel.port });
    const c = await client(await m.ecouter());
    await c.attendre(/^220 /);
    c.envoyer("EHLO executeur.test\r\n");
    await c.attendre(/250 AUTH PLAIN/);
    c.envoyer(`AUTH PLAIN ${Buffer.from(`\0${INST_A}\0${m.jeton(INST_A, CONN_A, CLIENT_A)}`).toString("base64")}\r\n`);
    await c.attendre(/235 /);
    c.envoyer(`MAIL FROM:<essai-a@exemple.fr>\r\nRCPT TO:<dest@exemple.fr>\r\nDATA\r\nSubject: t\r\n\r\n${MARQUEUR}\r\n.\r\n`);
    await c.attendre(/250 2\.0\.0 accepte/);
    expect(reel.recu).toContain(MARQUEUR);
    expect(c.tout()).not.toContain(MDP_A);
    c.envoyer("AUTH PLAIN AGF1dHJlAG1kcA==\r\n");
    await c.attendre(/50\d /);
    await new Promise((r) => setTimeout(r, 50));
    expect(reel.recu.filter((l) => l.startsWith("AUTH PLAIN")).length).toBe(1);
  });

  it("[A-335] SMTP @isolation : jeton d'une autre instance refusé comme un jeton inconnu", async () => {
    const reel = await fauxServeur("smtp", MDP_A, "essai-a@exemple.fr");
    const m = monter("smtp", { "serveur-a.exemple.test": reel.port, "serveur-b.exemple.test": reel.port });
    const port = await m.ecouter();
    const jetonA = m.jeton(INST_A, CONN_A, CLIENT_A);
    const rep: string[] = [];
    for (const [u, j] of [[INST_B, jetonA], [INST_A, "cj1_inconnu"]] as const) {
      const c = await client(port);
      c.envoyer(`AUTH PLAIN ${Buffer.from(`\0${u}\0${j}`).toString("base64")}\r\n`);
      await c.attendre(/535 /);
      rep.push(c.tout().replace(/^220[^\r]*\r\n/, ""));
    }
    expect(rep[0]).toBe(rep[1]);
    expect(m.ouvertures).toEqual([]);
  });

  it("[A-389] certificat du serveur du client invalide : connexion refusée, classe identification, rien d'autre ne revient à l'exécuteur", async () => {
    // 1. le TLS sortant vérifie le certificat et le nom
    const options: Record<string, unknown>[] = [];
    const faux = (o: Record<string, unknown>) => {
      options.push(o);
      const s = new EventEmitter();
      setImmediate(() => s.emit("error", Object.assign(new Error(`certificat de ${MDP_A}`), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })));
      s.destroy = () => undefined;
      return s;
    };
    const e = await ouvrirTlsVerifie({ hote: "serveur-a.exemple.test", port: 993 }, faux as never).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurMandataire);
    expect((e as ErreurMandataire).code).toBe("identification");
    expect((e as ErreurMandataire).message).not.toContain(MDP_A);
    expect(options[0]).toMatchObject({ host: "serveur-a.exemple.test", port: 993, servername: "serveur-a.exemple.test", rejectUnauthorized: true });
    // 2. côté exécuteur : refus générique, code journalisé
    const m = monter("imap", {});
    m.p.ouvrir = async () => Promise.reject(new ErreurMandataire("identification"));
    const c = await client(await m.ecouter());
    c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${INST_A}\0${m.jeton(INST_A, CONN_A, CLIENT_A)}`).toString("base64")}\r\n`);
    await c.attendre(/a1 NO/);
    expect(c.tout()).not.toMatch(/certificat|identification|serveur-a/i);
    expect(m.journal.join("\n")).toContain('"code":"identification"');
  });

  it("[A-335] le journal garde instance, hôte, durée, volume et code de fin, jamais une commande ni un contenu", async () => {
    const reel = await fauxServeur("imap", MDP_A, "essai-a@exemple.fr");
    const m = monter("imap", { "serveur-a.exemple.test": reel.port });
    const c = await client(await m.ecouter());
    c.envoyer(`a1 AUTHENTICATE PLAIN ${Buffer.from(`\0${INST_A}\0${m.jeton(INST_A, CONN_A, CLIENT_A)}`).toString("base64")}\r\n`);
    await c.attendre(/a1 OK/);
    c.envoyer(`a2 SELECT ${MARQUEUR}\r\na3 LOGOUT\r\n`);
    await c.attendre(/a3 OK/);
    c.s.end();
    for (let i = 0; i < 100 && m.journal.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const ligne = JSON.parse(m.journal.at(-1)!) as Record<string, unknown>;
    expect(ligne).toMatchObject({ instanceId: INST_A, hote: "serveur-a.exemple.test", code: "ok" });
    expect(typeof ligne["dureeMs"]).toBe("number");
    expect(ligne["octets"] as number).toBeGreaterThan(0);
    expect(m.journal.join("\n")).not.toMatch(new RegExp(`${MARQUEUR}|SELECT|${MDP_A}`));
  });
});
