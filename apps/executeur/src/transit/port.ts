// Ports du transit des pièces jointes (A-371, C-023) : le stockage et le chiffreur sont injectés, le code ne parle ni au coffre ni à la brique directement.

// Compartiment « transit » : un objet par copie, nom = <client>/<aléatoire>. `ecritLe` est la date d'écriture donnée PAR le stockage (pas par l'objet).
export interface PortTransit {
  ecrire(cle: string, octets: Uint8Array): Promise<void>;
  lire(cle: string): Promise<{ octets: Uint8Array; ecritLe: number } | undefined>;
  lister(): Promise<{ cle: string; ecritLe: number }[]>;
  supprimer(cle: string): Promise<void>;
}

export interface EnveloppeTransit {
  chiffre: Buffer;
  cleChiffree: string;
  version: number;
}

// Forme de apps/api/src/coffre/enveloppe.ts (clé du client, contexte lié au chiffré).
export interface Chiffreur {
  chiffrer(tenantId: string, octets: Buffer, contexte: string): Promise<EnveloppeTransit>;
  dechiffrer(tenantId: string, enveloppe: EnveloppeTransit, contexte: string): Promise<Buffer>;
}

export interface Horloge {
  maintenant(): number;
  attendre(ms: number, signal?: AbortSignal): Promise<void>;
}

export type CodeTransit = "reference_refusee" | "transit_absent" | "transit_expire" | "transit_illisible" | "transit_indisponible" | "client_invalide";

// Le message est le code seul : jamais un octet de la pièce jointe, ni le message du stockage ou du chiffreur.
export class ErreurTransit extends Error {
  constructor(readonly code: CodeTransit) {
    super(code);
    this.name = "ErreurTransit";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})$/;

export const validerClient = (tenantId: string): string => {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new ErreurTransit("client_invalide");
  return tenantId;
};

// Référence opaque : <client>/<64 hexadécimaux aléatoires>. Rend le client qui la porte, ou refuse (forme, ou autre client).
export function lireReference(reference: string, tenantId: string): string {
  const m = typeof reference === "string" ? REFERENCE.exec(reference) : null;
  if (!m || m[1] !== validerClient(tenantId)) throw new ErreurTransit("reference_refusee");
  return reference;
}

export const contexteTransit = (cle: string) => `transit:${cle}`;

// Format de l'objet : version (4 octets) | longueur de la clé chiffrée (2) | clé chiffrée | chiffré.
export function serialiser(e: EnveloppeTransit): Uint8Array {
  const cle = Buffer.from(e.cleChiffree, "utf8");
  const tete = Buffer.alloc(6);
  tete.writeUInt32BE(e.version, 0);
  tete.writeUInt16BE(cle.length, 4);
  return Buffer.concat([tete, cle, e.chiffre]);
}

export function lireObjet(brut: Uint8Array): EnveloppeTransit {
  const b = Buffer.from(brut);
  if (b.length < 6) throw new ErreurTransit("transit_illisible");
  const n = b.readUInt16BE(4);
  if (b.length < 6 + n) throw new ErreurTransit("transit_illisible");
  return { version: b.readUInt32BE(0), cleChiffree: b.subarray(6, 6 + n).toString("utf8"), chiffre: b.subarray(6 + n) };
}
