import { ErreurConnecteur, type Champ, type MessageLu, type MessageSortant } from "@axion-auto/connecteurs-commun";

export const ENTETE_INTENTION = "X-Axion-Intention";

const ADRESSE = /^[^\s@<>",;()\\]+@[^\s@<>",;()\\]+$/;
const ASCII = /^[\x20-\x7e]*$/;
const retour = (v: string) => v.replace(/.{1,76}/g, "$&\r\n").trimEnd();

// Objet non ASCII : mots encodés (RFC 2047) de 45 octets au plus, coupés entre deux caractères.
function objetEncode(objet: string): string {
  if (ASCII.test(objet)) return objet;
  const mots: string[] = [];
  let courant = "";
  for (const c of objet) {
    if (Buffer.byteLength(courant + c) > 45) { mots.push(courant); courant = ""; }
    courant += c;
  }
  mots.push(courant);
  return mots.map((m) => `=?UTF-8?B?${Buffer.from(m).toString("base64")}?=`).join("\r\n ");
}

// Message RFC 2822 en base64url, tel que l'attend Gmail. Le Message-ID choisi et l'intention sont posés ici : c'est ce qui
// permet de chercher le message après coup. Un saut de ligne dans un champ d'en-tête ferait passer un destinataire en douce.
export function messageBrut(m: MessageSortant): string {
  if (!ADRESSE.test(m.destinataire)) throw new ErreurConnecteur("definitive", "destinataire_invalide");
  if (/[\r\n\0]/.test(m.objet)) throw new ErreurConnecteur("definitive", "objet_invalide");
  const entetes = [
    `Message-ID: ${m.messageId}`, `${ENTETE_INTENTION}: ${m.messageId}`, `To: ${m.destinataire}`, `Subject: ${objetEncode(m.objet)}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
  ];
  return Buffer.from(`${entetes.join("\r\n")}\r\n\r\n${retour(Buffer.from(m.corps).toString("base64"))}`).toString("base64url");
}

type Partie = { mimeType?: string; body?: { data?: string }; parts?: Partie[]; headers?: { name?: string; value?: string }[] };
type Brut = { id?: string; labelIds?: string[]; internalDate?: string; payload?: Partie };

const decoder = (d: string) => Buffer.from(d, "base64url").toString("utf8");
function texte(p: Partie | undefined): string | undefined {
  if (!p) return undefined;
  if (p.mimeType === "text/plain" && typeof p.body?.data === "string") return decoder(p.body.data);
  for (const sous of p.parts ?? []) {
    const t = texte(sous);
    if (t !== undefined) return t;
  }
  return undefined;
}
const entete = (p: Partie | undefined, nom: string) => p?.headers?.find((h) => h.name?.toLowerCase() === nom)?.value;

// Ne rend que les champs demandés ; un champ que Gmail n'a pas renvoyé est une erreur, jamais une valeur vide.
// `nomsEtiquettes` traduit les identifiants d'étiquettes en noms (Gmail ne rend que des identifiants).
export function versMessageLu(brut: unknown, id: string, champs: Champ[], nomsEtiquettes: Map<string, string> = new Map()): MessageLu {
  if (typeof brut !== "object" || brut === null) throw new ErreurConnecteur("definitive", "reponse_inattendue");
  const b = brut as Brut;
  const date = Number(b.internalDate);
  const valeurs: Record<Champ, unknown> = {
    expediteur: entete(b.payload, "from"), objet: entete(b.payload, "subject"), corps: texte(b.payload),
    date: Number.isFinite(date) && b.internalDate ? new Date(date).toISOString() : undefined,
    etiquettes: b.labelIds?.map((l) => nomsEtiquettes.get(l) ?? l),
  };
  const sortie: Record<string, unknown> = { id };
  for (const c of champs) {
    if (valeurs[c] === undefined || valeurs[c] === null) throw new ErreurConnecteur("definitive", "champ_absent");
    sortie[c] = valeurs[c];
  }
  return sortie as MessageLu;
}
