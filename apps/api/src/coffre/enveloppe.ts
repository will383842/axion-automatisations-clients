import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appeler, ErreurCoffre, validerTenant, type OptionsBao } from "./coffre.js";

// Chiffrement par enveloppe (C-012) : une clé transit par client (cli-<tenantId>, non exportable).
// OpenBao fournit une clé de données ; le chiffrement se fait ici en AES-256-GCM, puis la clé en clair est remise à zéro.
// Le client est lié au chiffré par les données associées : même une clé de coffre partagée par erreur ne déchiffre rien pour un autre client.
// Détruire la clé du client rend ses chiffrés illisibles pour toujours.

export interface Enveloppe {
  chiffre: Buffer; // iv (12) | texte chiffré | étiquette (16)
  cleChiffree: string; // vault:v<version>:…
  version: number;
}

export interface OptionsEnveloppe extends OptionsBao {
  /** Pour les tests : reçoit la clé de données en clair APRÈS sa remise à zéro. */
  observerCle?: (cle: Buffer) => void;
}

const IV = 12;
const ETIQUETTE = 16;
const FORME_CLE_CHIFFREE = /^vault:v(\d+):[A-Za-z0-9+/]+={0,2}$/;
const nomCle = (tenantId: string) => `cli-${validerTenant(tenantId)}`;
const refus = (code: ConstructorParameters<typeof ErreurCoffre>[0] = "coffre_indisponible") => new ErreurCoffre(code);

function lireCle(base64: unknown): Buffer {
  if (typeof base64 !== "string") throw refus();
  const cle = Buffer.from(base64, "base64");
  if (cle.toString("base64") !== base64 || cle.length !== 32) {
    cle.fill(0);
    throw refus();
  }
  return cle;
}

function versionDe(cleChiffree: unknown): number {
  const m = typeof cleChiffree === "string" ? FORME_CLE_CHIFFREE.exec(cleChiffree) : null;
  const version = Number(m?.[1]);
  if (!m || !Number.isSafeInteger(version) || version < 1) throw refus("dechiffrement_impossible");
  return version;
}

export function creerEnveloppe(o: OptionsEnveloppe) {
  const finir = (cle: Buffer) => {
    cle.fill(0);
    o.observerCle?.(cle);
  };
  return {
    async creerCleClient(tenantId: string): Promise<void> {
      await appeler(o, "POST", `transit/keys/${nomCle(tenantId)}`, { type: "aes256-gcm96", exportable: false });
    },
    async chiffrer(tenantId: string, octets: Buffer): Promise<Enveloppe> {
      const donnees = (await appeler(o, "POST", `transit/datakey/plaintext/${nomCle(tenantId)}`, {})) as { data?: { plaintext?: unknown; ciphertext?: unknown } } | undefined;
      const cle = lireCle(donnees?.data?.plaintext);
      try {
        const cleChiffree = donnees?.data?.ciphertext;
        let version: number;
        try {
          version = versionDe(cleChiffree);
        } catch {
          throw refus();
        }
        const iv = randomBytes(IV);
        const c = createCipheriv("aes-256-gcm", cle, iv);
        c.setAAD(Buffer.from(tenantId));
        const chiffre = Buffer.concat([iv, c.update(octets), c.final(), c.getAuthTag()]);
        return { chiffre, cleChiffree: cleChiffree as string, version };
      } finally {
        finir(cle);
      }
    },
    async dechiffrer(tenantId: string, enveloppe: Enveloppe): Promise<Buffer> {
      const nom = nomCle(tenantId);
      if (versionDe(enveloppe.cleChiffree) !== enveloppe.version || enveloppe.chiffre.length < IV + ETIQUETTE) throw refus("dechiffrement_impossible");
      const donnees = (await appeler(o, "POST", `transit/decrypt/${nom}`, { ciphertext: enveloppe.cleChiffree })) as { data?: { plaintext?: unknown } } | undefined;
      const cle = lireCle(donnees?.data?.plaintext);
      try {
        const d = createDecipheriv("aes-256-gcm", cle, enveloppe.chiffre.subarray(0, IV));
        d.setAAD(Buffer.from(tenantId));
        d.setAuthTag(enveloppe.chiffre.subarray(enveloppe.chiffre.length - ETIQUETTE));
        return Buffer.concat([d.update(enveloppe.chiffre.subarray(IV, enveloppe.chiffre.length - ETIQUETTE)), d.final()]);
      } catch {
        throw refus("dechiffrement_impossible");
      } finally {
        finir(cle);
      }
    },
    // Effacement par destruction de clé : irréversible. La confirmation exacte évite la destruction par erreur d'appel.
    async detruireCleClient(tenantId: string, confirmation: string): Promise<void> {
      const nom = nomCle(tenantId);
      if (confirmation !== `detruire-${tenantId}`) throw refus("confirmation_absente");
      await appeler(o, "POST", `transit/keys/${nom}/config`, { deletion_allowed: true });
      await appeler(o, "DELETE", `transit/keys/${nom}`);
    },
  };
}
