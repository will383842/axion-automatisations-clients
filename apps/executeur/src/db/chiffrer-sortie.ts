import { z } from "zod";

// Sortie d'une étape (A-313, C-022) : seulement des identifiants et des codes, jamais de texte libre. Schéma fermé, puis chiffrement par la clé du client.
// Un « code » ou un identifiant : une seule suite de caractères sûrs, sans espace, 64 au plus. Pas de tableau, pas d'objet imbriqué.
const CLE = /^[a-z][a-z0-9_]{0,31}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_CHAMPS = 16;

export const SortieReduite = z
  .record(z.string().regex(CLE), z.union([z.string().regex(CODE), z.number().int().safe()]))
  .refine((o) => Object.keys(o).length <= MAX_CHAMPS, { message: "trop de champs" });
export type SortieReduite = z.infer<typeof SortieReduite>;

export function validerSortie(sortie: unknown): SortieReduite {
  return SortieReduite.parse(sortie);
}

// Ce que fournit le coffre (apps/api/src/coffre/enveloppe.ts) : une clé par client, le client lié au chiffré.
export interface Chiffreur {
  chiffrer(tenantId: string, octets: Buffer): Promise<{ chiffre: Buffer; cleChiffree: string; version: number }>;
  dechiffrer(tenantId: string, enveloppe: { chiffre: Buffer; cleChiffree: string; version: number }): Promise<Buffer>;
}

// Colonnes sortie_chiffree, sortie_cle et sortie_version de journal_etape.
export interface SortieChiffree {
  sortieChiffree: Buffer;
  sortieCle: string;
  sortieVersion: number;
}

export async function chiffrerSortie(chiffreur: Chiffreur, tenantId: string, sortie: unknown): Promise<SortieChiffree> {
  const valide = validerSortie(sortie);
  const e = await chiffreur.chiffrer(tenantId, Buffer.from(JSON.stringify(valide), "utf8"));
  return { sortieChiffree: e.chiffre, sortieCle: e.cleChiffree, sortieVersion: e.version };
}

export async function dechiffrerSortie(chiffreur: Chiffreur, tenantId: string, ligne: SortieChiffree): Promise<SortieReduite> {
  const clair = await chiffreur.dechiffrer(tenantId, { chiffre: ligne.sortieChiffree, cleChiffree: ligne.sortieCle, version: ligne.sortieVersion });
  return validerSortie(JSON.parse(clair.toString("utf8")));
}
