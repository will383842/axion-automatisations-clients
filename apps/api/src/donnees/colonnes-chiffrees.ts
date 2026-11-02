import { ErreurCoffre, appeler, validerTenant } from "../coffre/coffre.js";
import { creerEnveloppe, type Enveloppe, type OptionsEnveloppe } from "../coffre/enveloppe.js";

// Colonnes sensibles chiffrées par la clé du client (A-201, A-243, A-244).
// Chaque champ a sa propre clé de données (enveloppe de T1A-06, AES-256-GCM, nonce tiré à chaque chiffrement), remise à zéro après usage :
// aucune clé de données n'est gardée en mémoire (pas de cache : un cache chaud ne peut donc pas survivre à la destruction de la clé, A-245).
// Pas de repli : sans clé du client, ou avec le coffre scellé, on refuse (ErreurCoffre) ; on ne chiffre ni ne déchiffre jamais avec une autre clé.
//
// Normalisation avant empreinte (étape 4) :
//   e-mail    : tous les espaces retirés, minuscules ; exactement un « @ » entre deux parties non vides.
//   téléphone : espaces, points, tirets et parenthèses retirés ; « 00 » → « + » ; un « 0 » initial → « +33 » ; résultat E.164 : + puis 8 à 15 chiffres, le premier non nul.
// Format du bytea : 0x01 | version de clé (u32) | longueur de la clé de données chiffrée (u16) | clé de données chiffrée | nonce (12) | chiffré | étiquette (16).

const FORMAT = 1;
const ENTETE = 7;
const FORME_CLE_CHIFFREE = /^vault:v(\d+):[A-Za-z0-9+/]+={0,2}$/;
const FORME_HMAC = /^vault:v\d+:([A-Za-z0-9+/]{43}=)$/;
const illisible = () => new ErreurCoffre("dechiffrement_impossible");

export function normaliserEmail(valeur: string): string {
  const e = typeof valeur === "string" ? valeur.replace(/\s+/gu, "").toLowerCase() : "";
  if (!/^[^@]+@[^@]+$/u.test(e)) throw new Error("email_invalide");
  return e;
}

export function normaliserTelephone(valeur: string): string {
  let t = typeof valeur === "string" ? valeur.replace(/[\s.\-()]/gu, "") : "";
  if (t.startsWith("00")) t = `+${t.slice(2)}`;
  else if (t.startsWith("0")) t = `+33${t.slice(1)}`;
  if (!/^\+[1-9]\d{7,14}$/u.test(t)) throw new Error("telephone_invalide");
  return t;
}

export function serialiserEnveloppe(e: Enveloppe): Buffer {
  const cle = Buffer.from(e.cleChiffree, "utf8");
  const entete = Buffer.alloc(ENTETE);
  entete.writeUInt8(FORMAT, 0);
  entete.writeUInt32BE(e.version, 1);
  entete.writeUInt16BE(cle.length, 5);
  return Buffer.concat([entete, cle, e.chiffre]);
}

export function lireEnveloppeChamp(octets: Uint8Array): Enveloppe {
  const b = Buffer.from(octets);
  if (b.length < ENTETE || b.readUInt8(0) !== FORMAT) throw illisible();
  const version = b.readUInt32BE(1);
  const fin = ENTETE + b.readUInt16BE(5);
  const cleChiffree = b.subarray(ENTETE, fin).toString("utf8");
  const m = FORME_CLE_CHIFFREE.exec(cleChiffree);
  // 12 d'initialisation + 16 d'étiquette au minimum (même contrôle que l'enveloppe, qui refuse aussi un chiffré plus court).
  if (!m || Number(m[1]) !== version || b.length < fin + 28) throw illisible();
  return { version, cleChiffree, chiffre: b.subarray(fin) };
}

export function creerColonnesChiffrees(o: OptionsEnveloppe) {
  const enveloppe = creerEnveloppe(o);
  return {
    async chiffrerChamp(tenantId: string, valeur: string): Promise<Buffer> {
      return serialiserEnveloppe(await enveloppe.chiffrer(tenantId, Buffer.from(valeur, "utf8")));
    },
    async dechiffrerChamp(tenantId: string, octets: Uint8Array): Promise<string> {
      return (await enveloppe.dechiffrer(tenantId, lireEnveloppeChamp(octets))).toString("utf8");
    },
    // HMAC-SHA256 par une clé propre au client (transit cli-<id>-recherche, non exportable, créée au provisionnement) : jamais un hachage nu.
    async empreinteRecherche(tenantId: string, valeur: string): Promise<string> {
      const nom = `cli-${validerTenant(tenantId)}-recherche`;
      const normalisee = valeur.includes("@") ? normaliserEmail(valeur) : normaliserTelephone(valeur);
      const r = (await appeler(o, "POST", `transit/hmac/${nom}`, { input: Buffer.from(normalisee, "utf8").toString("base64"), algorithm: "sha2-256" })) as { data?: { hmac?: unknown } } | undefined;
      const m = typeof r?.data?.hmac === "string" ? FORME_HMAC.exec(r.data.hmac) : null;
      if (!m) throw new ErreurCoffre("coffre_indisponible");
      return Buffer.from(m[1] as string, "base64").toString("hex");
    },
    // Rotation : les anciennes versions restent gardées par le coffre, les anciens chiffrés restent lisibles.
    async pivoterCle(tenantId: string): Promise<void> {
      await appeler(o, "POST", `transit/keys/cli-${validerTenant(tenantId)}/rotate`, {});
    },
    // Rechiffre seulement la clé de données avec la version courante ; le chiffré des données ne change pas.
    async reenvelopper(tenantId: string, octets: Uint8Array): Promise<Buffer> {
      const e = lireEnveloppeChamp(octets);
      const r = (await appeler(o, "POST", `transit/rewrap/cli-${validerTenant(tenantId)}`, { ciphertext: e.cleChiffree })) as { data?: { ciphertext?: unknown } } | undefined;
      const nouvelle = typeof r?.data?.ciphertext === "string" ? r.data.ciphertext : "";
      const m = FORME_CLE_CHIFFREE.exec(nouvelle);
      if (!m) throw new ErreurCoffre("coffre_indisponible");
      return serialiserEnveloppe({ chiffre: e.chiffre, cleChiffree: nouvelle, version: Number(m[1]) });
    },
  };
}
