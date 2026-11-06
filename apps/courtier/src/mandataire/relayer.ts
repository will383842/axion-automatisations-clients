import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

// Relais du mandataire (T4-41, A-335) : octets relayés tels quels dans les deux sens, sauf trois garde-fous :
// 1. le filtre de commandes refuse toute nouvelle authentification ou montée en TLS demandée par l'exécuteur ;
// 2. le masqueur remplace le mot de passe (en clair ou en base64) s'il revient dans un message du serveur réel ;
// 3. le journal ne garde que l'instance, l'hôte, la durée, le volume et un code de fin.

export type CodeFin = "ok" | "refuse" | "identification" | "indisponible" | "commande_refusee";

// Le message est le code seul : jamais le texte d'une erreur du serveur réel ou de la pile TLS.
export class ErreurMandataire extends Error {
  constructor(readonly code: Exclude<CodeFin, "ok" | "commande_refusee">) {
    super(code);
    this.name = "ErreurMandataire";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOTE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
export interface Trace { instanceId?: string | undefined; hote?: string | undefined; dureeMs: number; octets: number; code: CodeFin }
// Liste blanche : une valeur de forme inattendue est écartée, jamais copiée.
export function ligneJournal(t: Trace): string {
  const l: Record<string, string | number> = { evenement: "mandataire", code: t.code, dureeMs: Math.max(0, Math.trunc(t.dureeMs)), octets: Math.max(0, Math.trunc(t.octets)) };
  if (t.instanceId && UUID.test(t.instanceId)) l["instanceId"] = t.instanceId;
  if (t.hote && HOTE.test(t.hote)) l["hote"] = t.hote;
  return JSON.stringify(l);
}

type Connecter = (o: { host: string; port: number; servername: string; rejectUnauthorized: true; minVersion: "TLSv1.2" }) => Duplex;
// Connexion sortante en TLS, certificat ET nom vérifiés. Jamais d'option qui désactive la vérification.
export function ouvrirTlsVerifie(cible: { hote: string; port: number }, connecter: Connecter = tlsConnect as unknown as Connecter, delaiMs = 10_000): Promise<Duplex> {
  return new Promise((resoudre, refuser) => {
    const s = connecter({ host: cible.hote, port: cible.port, servername: cible.hote, rejectUnauthorized: true, minVersion: "TLSv1.2" });
    const minuterie = setTimeout(() => (s.destroy(), refuser(new ErreurMandataire("indisponible"))), delaiMs);
    minuterie.unref?.();
    s.once("secureConnect", () => (clearTimeout(minuterie), resoudre(s)));
    s.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(minuterie);
      s.destroy();
      refuser(new ErreurMandataire(/CERT|SIGNATURE|ALTNAME|ISSUER|SELF_SIGNED/i.test(String(e?.code)) ? "identification" : "indisponible"));
    });
  });
}

// Lecture ligne à ligne avant le relais ; rend ensuite les octets déjà reçus mais non lus.
export class Lecteur {
  #tampon = Buffer.alloc(0);
  #fini = false;
  #reveil: (() => void) | undefined;
  readonly #sur = (b: Buffer) => ((this.#tampon = Buffer.concat([this.#tampon, b])), this.#reveil?.());
  readonly #fin = () => ((this.#fini = true), this.#reveil?.());
  constructor(private readonly s: Duplex, private readonly max = 8192) {
    s.on("data", this.#sur);
    s.on("end", this.#fin);
    s.on("close", this.#fin);
    s.on("error", this.#fin);
  }
  // Une ligne sans fin de ligne, sans octet nul, de taille bornée ; null si la connexion se ferme ; délai borné.
  async ligne(delaiMs = 30_000): Promise<string | null> {
    const limite = Date.now() + delaiMs;
    for (;;) {
      const i = this.#tampon.indexOf(10);
      if (i >= 0) {
        const brut = this.#tampon.subarray(0, i + 1);
        this.#tampon = this.#tampon.subarray(i + 1);
        if (brut.includes(0)) throw new ErreurMandataire("refuse");
        return brut.toString("latin1").replace(/\r?\n$/, "");
      }
      if (this.#tampon.length > this.max) throw new ErreurMandataire("refuse");
      if (this.#fini) return null;
      const reste = limite - Date.now();
      if (reste <= 0) throw new ErreurMandataire("indisponible");
      await new Promise<void>((r) => {
        const t = setTimeout(r, reste);
        t.unref?.();
        this.#reveil = () => (clearTimeout(t), r());
      });
      this.#reveil = undefined;
    }
  }
  detacher(): Buffer {
    this.s.off("data", this.#sur);
    this.s.off("end", this.#fin);
    this.s.off("close", this.#fin);
    this.s.pause();
    const r = this.#tampon;
    this.#tampon = Buffer.alloc(0);
    return r;
  }
}

const MAX_LIGNE = 65_536;
const IMAP_REFUSEES = new Set(["LOGIN", "AUTHENTICATE", "STARTTLS"]);
const SMTP_REFUSEES = new Set(["AUTH", "STARTTLS"]);
// Filtre des commandes de l'exécuteur après l'authentification. Il suit les littéraux IMAP ({n}), les données SMTP (DATA … « . ») et BDAT :
// des octets de données qui ressemblent à LOGIN passent, une vraie commande LOGIN, AUTHENTICATE, AUTH ou STARTTLS est refusée, quelle que soit la casse.
export class FiltreCommandes {
  #reste = Buffer.alloc(0);
  #litteral = 0;
  #data = false;
  constructor(private readonly protocole: "imap" | "smtp") {}
  pousser(octets: Buffer): { transmis: Buffer; refus?: string } {
    const buf = Buffer.concat([this.#reste, octets]);
    const sortie: Buffer[] = [];
    let pos = 0;
    this.#reste = Buffer.alloc(0);
    while (pos < buf.length) {
      if (this.#litteral > 0) {
        const n = Math.min(this.#litteral, buf.length - pos);
        sortie.push(buf.subarray(pos, pos + n));
        pos += n;
        this.#litteral -= n;
        continue;
      }
      const nl = buf.indexOf(10, pos);
      if (nl < 0) {
        if (buf.length - pos > MAX_LIGNE) return { transmis: Buffer.concat(sortie), refus: this.#refus("") };
        this.#reste = buf.subarray(pos);
        break;
      }
      const ligne = buf.subarray(pos, nl + 1);
      const texte = ligne.toString("latin1").replace(/\r?\n$/, "");
      pos = nl + 1;
      if (this.protocole === "smtp" && this.#data) {
        if (texte === ".") this.#data = false;
        sortie.push(ligne);
        continue;
      }
      const r = this.protocole === "imap" ? this.#imap(texte) : this.#smtp(texte);
      if (r.refus !== undefined) return { transmis: Buffer.concat(sortie), refus: r.refus };
      sortie.push(ligne);
    }
    return { transmis: Buffer.concat(sortie) };
  }
  #refus(tag: string): string {
    return this.protocole === "imap" ? `${/^[A-Za-z0-9.]{1,32}$/.test(tag) ? tag : "*"} BAD commande refusee\r\n` : "503 5.5.1 commande refusee\r\n";
  }
  #imap(texte: string): { refus?: string } {
    const m = /^(\S+)\s+([A-Za-z]+)/.exec(texte);
    if (m && IMAP_REFUSEES.has(m[2]!.toUpperCase())) return { refus: this.#refus(m[1]!) };
    const l = /\{(\d{1,9})\+?\}$/.exec(texte);
    if (l) this.#litteral = Number(l[1]);
    return {};
  }
  #smtp(texte: string): { refus?: string } {
    const verbe = /^\s*([A-Za-z]+)/.exec(texte)?.[1]?.toUpperCase() ?? "";
    if (SMTP_REFUSEES.has(verbe)) return { refus: this.#refus("") };
    if (verbe === "DATA" && /^\s*DATA\s*$/i.test(texte)) this.#data = true;
    const b = verbe === "BDAT" ? /^\s*BDAT\s+(\d{1,9})/i.exec(texte) : null;
    if (b) this.#litteral = Number(b[1]);
    return {};
  }
}

// Masque les secrets dans les messages du serveur réel, même coupés entre deux paquets : seule la fin qui pourrait commencer un secret est retenue.
export class Masqueur {
  #carry = "";
  readonly #secrets: string[];
  constructor(secrets: string[]) {
    this.#secrets = secrets.filter((s) => s.length > 0);
  }
  // Même longueur que le secret : un littéral IMAP « {N} » ou une taille SMTP annoncés par le serveur restent exacts (sinon le client se désynchronise).
  #remplacer(t: string): string {
    return this.#secrets.reduce((acc, s) => acc.split(s).join("*".repeat(s.length)), t);
  }
  pousser(octets: Buffer): Buffer {
    const t = this.#remplacer(this.#carry + octets.toString("latin1"));
    let garde = 0;
    for (const s of this.#secrets) for (let n = Math.min(s.length - 1, t.length); n > garde; n--) if (t.endsWith(s.slice(0, n))) garde = n;
    this.#carry = t.slice(t.length - garde);
    return Buffer.from(t.slice(0, t.length - garde), "latin1");
  }
  fin(): Buffer {
    const r = Buffer.from(this.#remplacer(this.#carry), "latin1");
    this.#carry = "";
    return r;
  }
}

export interface OptionsRelais { protocole: "imap" | "smtp"; secrets: string[]; deClient?: Buffer; deServeur?: Buffer }
// Relais jusqu'à la fermeture d'un côté. Rend le volume total et le code de fin.
export function relayer(client: Duplex, serveur: Duplex, o: OptionsRelais): Promise<{ octets: number; code: CodeFin }> {
  return new Promise((fin) => {
    const filtre = new FiltreCommandes(o.protocole);
    const masque = new Masqueur(o.secrets);
    let octets = 0;
    let code: CodeFin = "ok";
    let termine = false;
    const finir = (c?: CodeFin) => {
      if (c && code === "ok") code = c;
      if (termine) return;
      termine = true;
      client.destroy();
      serveur.destroy();
      fin({ octets, code });
    };
    const ecrire = (dest: Duplex, source: Duplex, b: Buffer) => {
      if (b.length === 0) return;
      octets += b.length;
      if (!dest.write(b)) {
        source.pause();
        dest.once("drain", () => source.resume());
      }
    };
    const versServeur = (b: Buffer) => {
      const r = filtre.pousser(b);
      ecrire(serveur, client, r.transmis);
      if (r.refus !== undefined) {
        code = "commande_refusee";
        client.write(r.refus, () => finir());
      }
    };
    client.on("data", (b: Buffer) => !termine && code === "ok" && versServeur(b));
    serveur.on("data", (b: Buffer) => !termine && ecrire(client, serveur, masque.pousser(b)));
    // Fermeture du serveur réel : ce qui restait retenu est masqué puis rendu, puis le client est fermé.
    serveur.on("end", () => (ecrire(client, serveur, masque.fin()), client.end()));
    client.on("end", () => serveur.end());
    for (const s of [client, serveur]) {
      s.on("error", () => finir("indisponible"));
      s.on("close", () => finir());
    }
    if (o.deServeur?.length) ecrire(client, serveur, masque.pousser(o.deServeur));
    if (o.deClient?.length) versServeur(o.deClient);
    client.resume();
    serveur.resume();
  });
}
