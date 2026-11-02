import { createHash, timingSafeEqual } from "node:crypto";
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
// Contexte lié au chiffré : le clair chiffré est précédé de son contexte (u16 + octets), vérifié en temps constant au déchiffrement.
//   champ   : « <table>.<colonne>:<idLigne> » (ex. personnes.courriel_chiffre:<uuid>) ; fichier : « fichier:<cle> ».
//   La colonne ne contient ni « : » ni le préfixe « fichier » : un champ ne peut jamais se lire comme un fichier, ni l'inverse.
//   Un chiffré copié sur une autre ligne, une autre colonne ou une autre clé d'objet du même client est donc refusé.
//   Le durcissement définitif (contexte dans les données associées de l'enveloppe) est la dette LOT2-dette-T2-33-aad-contexte.
// Empreinte : HMAC-SHA256 en 32 octets (colonne bytea, octet_length = 32), version de clé épinglée à 1 : une rotation de la clé de recherche ne change pas l'index.
// Format du bytea : 0x01 | version de clé (u32) | longueur de la clé de données chiffrée (u16) | clé de données chiffrée | nonce (12) | chiffré | étiquette (16).

const FORMAT = 1;
const ENTETE = 7;
const FORME_CLE_CHIFFREE = /^vault:v(\d+):[A-Za-z0-9+/]+={0,2}$/;
const FORME_HMAC = /^vault:v(\d+):([A-Za-z0-9+/]{43}=)$/;
const VERSION_EMPREINTE = 1;
const FORME_COLONNE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const illisible = () => new ErreurCoffre("dechiffrement_impossible");

export interface ContexteChamp {
  colonne: string; // « table.colonne »
  idLigne: string;
}

export function contexteChamp(c: ContexteChamp): string {
  if (typeof c?.colonne !== "string" || !FORME_COLONNE.test(c.colonne) || typeof c.idLigne !== "string" || c.idLigne === "" || [...c.idLigne].some((x) => (x.codePointAt(0) ?? 0) < 32)) throw new Error("contexte_invalide");
  return `${c.colonne}:${c.idLigne}`;
}

export function contexteFichier(cle: string): string {
  if (typeof cle !== "string" || cle === "") throw new Error("contexte_invalide");
  return `fichier:${cle}`;
}

/** Précède le clair de son contexte. Le Buffer rendu contient le clair : l'appelant le remet à zéro après chiffrement. */
export function lierContexte(contexte: string, clair: Buffer): Buffer {
  const c = Buffer.from(contexte, "utf8");
  if (c.length > 0xffff) throw new Error("contexte_invalide");
  const tete = Buffer.alloc(2);
  tete.writeUInt16BE(c.length, 0);
  return Buffer.concat([tete, c, clair]);
}

/** Vérifie le contexte en temps constant (comparaison des condensés) et rend le clair ; sinon refus neutre. */
export function delierContexte(contexte: string, charge: Buffer): Buffer {
  const condense = (b: Uint8Array) => createHash("sha256").update(b).digest();
  const n = charge.length >= 2 ? charge.readUInt16BE(0) : -1;
  const lu = n >= 0 && charge.length >= 2 + n ? charge.subarray(2, 2 + n) : Buffer.alloc(0);
  const bon = timingSafeEqual(condense(lu), condense(Buffer.from(contexte, "utf8"))) && n >= 0 && charge.length >= 2 + n;
  if (!bon) {
    charge.fill(0);
    throw illisible();
  }
  return charge.subarray(2 + n);
}

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
    async chiffrerChamp(tenantId: string, valeur: string, contexte: ContexteChamp): Promise<Buffer> {
      const lie = lierContexte(contexteChamp(contexte), Buffer.from(valeur, "utf8"));
      try {
        return serialiserEnveloppe(await enveloppe.chiffrer(tenantId, lie));
      } finally {
        lie.fill(0);
      }
    },
    async dechiffrerChamp(tenantId: string, octets: Uint8Array, contexte: ContexteChamp): Promise<string> {
      const attendu = contexteChamp(contexte);
      const charge = await enveloppe.dechiffrer(tenantId, lireEnveloppeChamp(octets));
      const clair = delierContexte(attendu, charge);
      try {
        return clair.toString("utf8");
      } finally {
        charge.fill(0);
      }
    },
    // HMAC-SHA256 par une clé propre au client (transit cli-<id>-recherche, non exportable, créée au provisionnement) : jamais un hachage nu.
    async empreinteRecherche(tenantId: string, valeur: string): Promise<Buffer> {
      const nom = `cli-${validerTenant(tenantId)}-recherche`;
      const normalisee = valeur.includes("@") ? normaliserEmail(valeur) : normaliserTelephone(valeur);
      const r = (await appeler(o, "POST", `transit/hmac/${nom}`, { input: Buffer.from(normalisee, "utf8").toString("base64"), algorithm: "sha2-256", key_version: VERSION_EMPREINTE })) as { data?: { hmac?: unknown } } | undefined;
      const m = typeof r?.data?.hmac === "string" ? FORME_HMAC.exec(r.data.hmac) : null;
      // Version épinglée : une réponse d'une autre version fausserait l'index (et la jointure avec les exclusions) en silence.
      if (!m || Number(m[1]) !== VERSION_EMPREINTE) throw new ErreurCoffre("coffre_indisponible");
      const empreinte = Buffer.from(m[2] as string, "base64");
      if (empreinte.length !== 32) throw new ErreurCoffre("coffre_indisponible");
      return empreinte;
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
