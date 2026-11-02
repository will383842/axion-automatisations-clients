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
// Contexte lié au chiffré : « <table>.<colonne>:<idLigne> » pour un champ, « fichier:<cle> » pour un objet. La colonne ne contient ni « : » ni le préfixe « fichier ».
//   Format 2 (écrit désormais) : le contexte est dans les données associées (AAD) de l'enveloppe, le clair est la valeur seule.
//   Format 1 (anciens chiffrés de T2-33) : le contexte précède le clair (u16 + octets), vérifié en temps constant. Il reste LU pendant la transition ;
//   le balayage (balayage-chiffres.ts) reprend chaque ancien chiffré au format 2, après quoi la lecture du format 1 pourra être retirée.
// Empreinte : HMAC-SHA256 en 32 octets (colonne bytea, octet_length = 32), version de clé épinglée à 1 : une rotation de la clé de recherche ne change pas l'index.
// Format du bytea : 0x01 ou 0x02 (voir ci-dessus) | version de clé (u32) | longueur de la clé de données chiffrée (u16) | clé de données chiffrée | nonce (12) | chiffré | étiquette (16).

const FORMAT = 2;
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

export type FormatChamp = 1 | 2;

export function formatChamp(octets: Uint8Array): FormatChamp {
  const f = octets[0];
  if (f !== 1 && f !== 2) throw illisible();
  return f;
}

export function serialiserEnveloppe(e: Enveloppe, format: FormatChamp = FORMAT): Buffer {
  const cle = Buffer.from(e.cleChiffree, "utf8");
  const entete = Buffer.alloc(ENTETE);
  entete.writeUInt8(format, 0);
  entete.writeUInt32BE(e.version, 1);
  entete.writeUInt16BE(cle.length, 5);
  return Buffer.concat([entete, cle, e.chiffre]);
}

export function lireEnveloppeChamp(octets: Uint8Array): Enveloppe {
  const b = Buffer.from(octets);
  if (b.length < ENTETE || (b.readUInt8(0) !== 1 && b.readUInt8(0) !== 2)) throw illisible();
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
  const chiffrerLie = async (tenantId: string, clair: Buffer, contexte: string): Promise<Buffer> => serialiserEnveloppe(await enveloppe.chiffrer(tenantId, clair, contexte));
  // Lit les deux formats. Le Buffer rendu contient le clair : l'appelant le remet à zéro.
  const dechiffrerLie = async (tenantId: string, octets: Uint8Array, contexte: string): Promise<Buffer> => {
    const e = lireEnveloppeChamp(octets);
    if (formatChamp(octets) === 2) return enveloppe.dechiffrer(tenantId, e, contexte);
    return delierContexte(contexte, await enveloppe.dechiffrer(tenantId, e));
  };
  // Rechiffre seulement la clé de données avec la version courante ; le chiffré des données ne change pas (le format est gardé).
  const reenvelopper = async (tenantId: string, octets: Uint8Array): Promise<Buffer> => {
    const e = lireEnveloppeChamp(octets);
    const r = (await appeler(o, "POST", `transit/rewrap/cli-${validerTenant(tenantId)}`, { ciphertext: e.cleChiffree })) as { data?: { ciphertext?: unknown } } | undefined;
    const nouvelle = typeof r?.data?.ciphertext === "string" ? r.data.ciphertext : "";
    const m = FORME_CLE_CHIFFREE.exec(nouvelle);
    if (!m) throw new ErreurCoffre("coffre_indisponible");
    return serialiserEnveloppe({ chiffre: e.chiffre, cleChiffree: nouvelle, version: Number(m[1]) }, formatChamp(octets));
  };
  return {
    async chiffrerChamp(tenantId: string, valeur: string, contexte: ContexteChamp): Promise<Buffer> {
      const clair = Buffer.from(valeur, "utf8");
      try {
        return await chiffrerLie(tenantId, clair, contexteChamp(contexte));
      } finally {
        clair.fill(0);
      }
    },
    async dechiffrerChamp(tenantId: string, octets: Uint8Array, contexte: ContexteChamp): Promise<string> {
      const clair = await dechiffrerLie(tenantId, octets, contexteChamp(contexte));
      try {
        return clair.toString("utf8");
      } finally {
        clair.fill(0);
      }
    },
    // HMAC-SHA256 par une clé propre au client (transit cli-<id>-recherche, non exportable, créée au provisionnement) : jamais un hachage nu.
    async empreinteRecherche(tenantId: string, valeur: string): Promise<Buffer> {
      if (typeof valeur !== "string") throw new Error("valeur_invalide");
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
    reenvelopper,
    // Reprise d'un chiffré par le balayage. Rien n'est rendu avant d'avoir relu le résultat et trouvé la même donnée ; l'appelant ne remplace
    // l'ancien qu'avec ce résultat. Format 2 : réenveloppement (clé de données seule) ; format 1 : rechiffrement au format 2 (contexte dans l'AAD).
    async reprendre(tenantId: string, octets: Uint8Array, contexte: string): Promise<{ octets: Buffer; etat: "a_jour" | "reenveloppe" | "migre" }> {
      const ancien = await dechiffrerLie(tenantId, octets, contexte);
      let nouveau: Buffer | undefined;
      let relu: Buffer | undefined;
      try {
        let etat: "a_jour" | "reenveloppe" | "migre" = "migre";
        if (formatChamp(octets) === 2) {
          nouveau = await reenvelopper(tenantId, octets);
          if (lireEnveloppeChamp(nouveau).version <= lireEnveloppeChamp(octets).version) return { octets: Buffer.from(octets), etat: "a_jour" };
          etat = "reenveloppe";
        } else nouveau = await chiffrerLie(tenantId, ancien, contexte);
        relu = await dechiffrerLie(tenantId, nouveau, contexte);
        if (relu.length !== ancien.length || !timingSafeEqual(relu, ancien)) throw illisible();
        return { octets: nouveau, etat };
      } finally {
        ancien.fill(0);
        relu?.fill(0);
      }
    },
  };
}
