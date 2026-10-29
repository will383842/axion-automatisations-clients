// Dimensionnement du volume pg_wal (T1B-06, C-602). Fonctions pures.
// Règle : volume ≥ plafond de la file (archive-push-queue-max) + débit maximal de journaux × durée + marge de max_wal_size.
// Le débit maximal est [À DÉFINIR] (mesure en T1B-09 / T8A-10) : aucune valeur de production ici, l'appelant le fournit.

export const DUREE_PAR_DEFAUT_MIN = 10;
// Part du volume à partir de laquelle l'occupation de pg_wal alerte. Le seuil doit rester sous le plafond de la file (alerte AVANT le plafond).
export const PART_ALERTE_VOLUME = 0.6;

export interface EntreesDimensionnement {
  plafondFile: number; // octets : archive-push-queue-max
  debitMaxOctetsParSeconde: number; // octets de journaux par seconde, au pire
  maxWalSize: number; // octets : marge de max_wal_size
  dureeMinutes?: number; // défaut 10
}

const positif = (nom: string, v: number) => {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${nom} doit être un nombre fini, positif ou nul`);
};

export function dimensionnerWal(e: EntreesDimensionnement): number {
  const duree = e.dureeMinutes ?? DUREE_PAR_DEFAUT_MIN;
  positif("plafondFile", e.plafondFile);
  positif("debitMaxOctetsParSeconde", e.debitMaxOctetsParSeconde);
  positif("maxWalSize", e.maxWalSize);
  positif("dureeMinutes", duree);
  return e.plafondFile + e.debitMaxOctetsParSeconde * duree * 60 + e.maxWalSize;
}

// Octets de pg_wal à partir desquels l'alerte part ; refuse un volume où ce seuil ne serait pas strictement sous le plafond de la file.
export function seuilAlerteWal(volume: number, plafondFile: number, part: number = PART_ALERTE_VOLUME): number {
  positif("volume", volume);
  positif("plafondFile", plafondFile);
  const seuil = volume * part;
  if (seuil >= plafondFile) throw new Error("le seuil d'alerte de pg_wal doit rester strictement sous le plafond de la file");
  return seuil;
}
