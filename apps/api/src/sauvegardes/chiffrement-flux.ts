import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ErreurCoffre } from "../coffre/coffre.js";

// Chiffrement d'un gros flux par blocs authentifiés (T2-39, A-239) : AES-256-GCM, jamais plus d'un bloc en mémoire.
//
// FORMAT (version 1), tout en gros-boutiste :
//   en-tête : "AXDM" (4) | version de format (1) | version de clé (4) | préfixe de nonce (4) | taille de bloc (4) | longueur L de la clé chiffrée (2) | clé de données chiffrée (L, texte « vault:v<n>:… »)
//   puis des blocs : longueur du chiffré (4) | chiffré (clair du bloc, jusqu'à « taille de bloc » octets) | étiquette (16)
// Nonce du bloc i (12 octets) = préfixe (4) | i sur 8 octets. La clé de données est propre à CE dump : un nonce ne se répète jamais avec la même clé.
// Données associées de chaque bloc = identité du client | 0x00 | en-tête | drapeau « dernier bloc » (1). Elles lient chaque bloc au client et à l'en-tête
// (un en-tête déplacé ou une clé d'un autre client échoue), et le drapeau empêche de couper la fin du flux sans que cela se voie.
// Le dernier bloc existe toujours (il peut être vide) ; rien ne doit le suivre.
// Toute erreur de lecture est la même : « dechiffrement_impossible » (aucun détail sur ce qui a échoué).

export const TAILLE_BLOC = 64 * 1024;
const MAGIE = Buffer.from("AXDM");
const FORMAT = 1;
const ETIQUETTE = 16;
const BLOC_MAX = 1024 * 1024;

export interface Entete {
  versionFormat: number;
  versionCle: number;
  cleChiffree: string;
}
const echec = () => new ErreurCoffre("dechiffrement_impossible");

function encoderEntete(e: Pick<Entete, "versionCle" | "cleChiffree">, prefixe: Buffer, bloc: number): Buffer {
  const cle = Buffer.from(e.cleChiffree, "utf8");
  const tete = Buffer.alloc(4 + 1 + 4 + 4 + 4 + 2);
  MAGIE.copy(tete);
  tete.writeUInt8(FORMAT, 4);
  tete.writeUInt32BE(e.versionCle, 5);
  prefixe.copy(tete, 9);
  tete.writeUInt32BE(bloc, 13);
  tete.writeUInt16BE(cle.length, 17);
  return Buffer.concat([tete, cle]);
}

const nonce = (prefixe: Buffer, i: number) => {
  const n = Buffer.alloc(12);
  prefixe.copy(n);
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
};
const associees = (tenantId: string, entete: Buffer, dernier: boolean) => Buffer.concat([Buffer.from(tenantId), Buffer.from([0]), entete, Buffer.from([dernier ? 1 : 0])]);

// Chiffre « source » ; produit l'en-tête puis les blocs. La clé est copiée dès l'appel (la copie est remise à zéro à la fin du flux) : l'appelant peut remettre la sienne à zéro quand il veut.
export function chiffrerFlux(source: AsyncIterable<Buffer>, cleAppelant: Buffer, e: Pick<Entete, "versionCle" | "cleChiffree">, tenantId: string, tailleBloc = TAILLE_BLOC): AsyncGenerator<Buffer> {
  // Copie IMMÉDIATE (pas au premier bloc) : l'appelant peut remettre sa clé à zéro sans effet sur ce flux. Une clé de mauvaise taille ou nulle est refusée.
  if (cleAppelant.length !== 32 || cleAppelant.every((o) => o === 0)) throw new Error("cle_invalide");
  const cle = Buffer.from(cleAppelant);
  return chiffrerBlocs(source, cle, e, tenantId, tailleBloc);
}
async function* chiffrerBlocs(source: AsyncIterable<Buffer>, cle: Buffer, e: Pick<Entete, "versionCle" | "cleChiffree">, tenantId: string, tailleBloc: number): AsyncGenerator<Buffer> {
  try {
    yield* blocs(source, cle, e, tenantId, tailleBloc);
  } finally {
    cle.fill(0);
  }
}
async function* blocs(source: AsyncIterable<Buffer>, cle: Buffer, e: Pick<Entete, "versionCle" | "cleChiffree">, tenantId: string, tailleBloc: number): AsyncGenerator<Buffer> {
  const prefixe = randomBytes(4);
  const entete = encoderEntete(e, prefixe, tailleBloc);
  yield entete;
  let i = 0;
  const bloc = (clair: Buffer, dernier: boolean) => {
    const c = createCipheriv("aes-256-gcm", cle, nonce(prefixe, i++));
    c.setAAD(associees(tenantId, entete, dernier));
    const chiffre = Buffer.concat([c.update(clair), c.final(), c.getAuthTag()]);
    const longueur = Buffer.alloc(4);
    longueur.writeUInt32BE(chiffre.length);
    return Buffer.concat([longueur, chiffre]);
  };
  let reste: Buffer = Buffer.alloc(0);
  for await (const morceau of source) {
    reste = reste.length ? Buffer.concat([reste, morceau]) : morceau;
    // Strictement plus grand : il reste toujours au moins un octet pour le dernier bloc.
    while (reste.length > tailleBloc) {
      yield bloc(reste.subarray(0, tailleBloc), false);
      reste = reste.subarray(tailleBloc);
    }
  }
  yield bloc(reste, true);
}

// Lecteur de « n » octets exactement sur un flux découpé n'importe comment.
function lecteur(source: AsyncIterable<Buffer>) {
  const it = source[Symbol.asyncIterator]();
  let tampon: Buffer = Buffer.alloc(0);
  return async (n: number): Promise<Buffer | undefined> => {
    while (tampon.length < n) {
      const { value, done } = await it.next();
      if (done) return undefined;
      tampon = tampon.length ? Buffer.concat([tampon, value as Buffer]) : (value as Buffer);
    }
    const sortie = tampon.subarray(0, n);
    tampon = tampon.subarray(n);
    return sortie;
  };
}

// Relit un dump. « ouvrirCle » reçoit l'en-tête et rend la clé de données en clair (via le coffre, avec la clé du client) ; elle est remise à zéro à la fin.
export async function* dechiffrerFlux(source: AsyncIterable<Buffer>, tenantId: string, ouvrirCle: (e: Entete) => Promise<Buffer>): AsyncGenerator<Buffer> {
  const lire = lecteur(source);
  const tete = await lire(19);
  if (!tete || !tete.subarray(0, 4).equals(MAGIE) || tete.readUInt8(4) !== FORMAT) throw echec();
  const tailleBloc = tete.readUInt32BE(13);
  if (tailleBloc < 16 || tailleBloc > BLOC_MAX) throw echec();
  const cleChiffree = await lire(tete.readUInt16BE(17));
  if (!cleChiffree) throw echec();
  const entete = Buffer.concat([tete, cleChiffree]);
  const prefixe = tete.subarray(9, 13);
  const cle = await ouvrirCle({ versionFormat: FORMAT, versionCle: tete.readUInt32BE(5), cleChiffree: cleChiffree.toString("utf8") });
  try {
    if (cle.length !== 32) throw echec();
    for (let i = 0; ; i++) {
      const lg = await lire(4);
      if (!lg) throw echec(); // fin coupée : le dernier bloc manque
      const n = lg.readUInt32BE(0);
      if (n < ETIQUETTE || n > tailleBloc + ETIQUETTE) throw echec();
      const chiffre = await lire(n);
      if (!chiffre) throw echec();
      // Le bloc est « dernier » s'il est plus court que la taille de bloc ou si plus rien ne suit : on essaie les deux lectures, une seule est authentique.
      const clair = ouvrir(cle, nonce(prefixe, i), associees(tenantId, entete, false), chiffre) ?? ouvrir(cle, nonce(prefixe, i), associees(tenantId, entete, true), chiffre, true);
      if (clair === undefined) throw echec();
      if (clair.dernier) {
        if (await lire(1)) throw echec(); // rien ne doit suivre
        yield clair.octets;
        return;
      }
      yield clair.octets;
    }
  } finally {
    cle.fill(0);
  }
}

function ouvrir(cle: Buffer, n: Buffer, aad: Buffer, chiffre: Buffer, dernier = false): { octets: Buffer; dernier: boolean } | undefined {
  try {
    const d = createDecipheriv("aes-256-gcm", cle, n);
    d.setAAD(aad);
    d.setAuthTag(chiffre.subarray(chiffre.length - ETIQUETTE));
    return { octets: Buffer.concat([d.update(chiffre.subarray(0, chiffre.length - ETIQUETTE)), d.final()]), dernier };
  } catch {
    return undefined;
  }
}
