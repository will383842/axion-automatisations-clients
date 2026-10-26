import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";

// Mesure et décision sur l'occupation du disque des données et des journaux en attente d'archivage.
// Fonctions pures, plus deux lectures du système. La sonde extérieure du lot 1-B réutilise `decider`.

export interface Mesure {
  t: number; // millisecondes depuis l'époque
  utilises: number; // octets utilisés sur le volume des données
  total: number; // octets du volume
  journauxEnAttente: number; // octets de journaux non encore archivés
}
export interface Parametres {
  seuilAlerte: number; // part du disque, ex. 0.8 (SEUIL_ALERTE_DISQUE)
  plafondJournaux: number; // octets (PLAFOND_JOURNAUX_EN_ATTENTE)
  horizonReveilMs: number; // 6 h : décision W-c2
}
export type Niveau = "rien" | "saturation_proche" | "plafond_proche" | "plafond_atteint";
// Part du plafond à partir de laquelle l'alerte part, avant que pgBackRest abandonne des journaux.
export const PART_ALERTE_PLAFOND = 0.5;
// Lu dans pg_stat_archiver : last_archived_time, last_failed_time ; journauxAbandonnes vient de l'archivage (file dépassée).
export interface EtatArchivage { dernierArchivage?: number; dernierEchec?: number; journauxAbandonnes?: boolean }
export interface Decision {
  niveau: Niveau;
  reveil: boolean;
  saturationPrevue: number | null; // millisecondes depuis l'époque
  message: string;
}

// Régression linéaire de l'occupation sur les dernières mesures ; null si elle ne monte pas.
export function previsionSaturation(mesures: Mesure[]): number | null {
  const n = mesures.length;
  if (n < 2) return null;
  const mt = mesures.reduce((s, m) => s + m.t, 0) / n;
  const mu = mesures.reduce((s, m) => s + m.utilises, 0) / n;
  let num = 0;
  let den = 0;
  for (const m of mesures) {
    num += (m.t - mt) * (m.utilises - mu);
    den += (m.t - mt) ** 2;
  }
  if (den === 0 || num <= 0) return null;
  const pente = num / den;
  const derniere = mesures[n - 1]!;
  return derniere.t + (derniere.total - derniere.utilises) / pente;
}

const heure = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

// Seulement le volume, le taux et l'heure prévue : ni client, ni adresse, ni nom d'hôte.
export function messageAlerte(niveau: Exclude<Niveau, "rien">, m: Mesure, prevue: number | null, depuis?: number): string {
  const taux = Math.round((m.utilises / m.total) * 100);
  if (niveau === "plafond_proche") return `Journaux en attente d'archivage à plus de la moitié du plafond. Disque des données à ${taux} %.`;
  if (niveau === "plafond_atteint") {
    const quand = depuis === undefined ? "" : ` depuis ${heure(depuis)}`;
    return `Archivage interrompu, la reprise à un instant précis n'est plus garantie${quand}. Disque des données à ${taux} %.`;
  }
  const fin = prevue === null ? "" : `, saturation prévue vers ${heure(prevue)}`;
  return `Disque des données à ${taux} %${fin}.`;
}

export function decider(mesures: Mesure[], p: Parametres, maintenant: number, etat: EtatArchivage = {}): Decision {
  const m = mesures[mesures.length - 1];
  if (!m) return { niveau: "rien", reveil: false, saturationPrevue: null, message: "" };
  const prevue = previsionSaturation(mesures);
  const reveil = prevue !== null && prevue - maintenant < p.horizonReveilMs;
  // Réveil : seulement si la saturation est prévue dans moins de 6 h (W-c2), au plafond comme ailleurs.
  if (m.journauxEnAttente >= p.plafondJournaux || etat.journauxAbandonnes) {
    return { niveau: "plafond_atteint", reveil, saturationPrevue: prevue, message: messageAlerte("plafond_atteint", m, prevue, etat.dernierArchivage) };
  }
  if (m.journauxEnAttente >= p.plafondJournaux * PART_ALERTE_PLAFOND) {
    return { niveau: "plafond_proche", reveil, saturationPrevue: prevue, message: messageAlerte("plafond_proche", m, prevue) };
  }
  if (m.utilises / m.total >= p.seuilAlerte || reveil) {
    return { niveau: "saturation_proche", reveil, saturationPrevue: prevue, message: messageAlerte("saturation_proche", m, prevue) };
  }
  return { niveau: "rien", reveil: false, saturationPrevue: prevue, message: "" };
}

// Lectures du système. total = utilisé + disponible pour un utilisateur ordinaire : l'espace réservé à root n'y est pas,
// car PostgreSQL reçoit ENOSPC quand bavail tombe à 0.
type Statfs = { blocks: number; bfree: number; bavail: number; bsize: number };
export function lireOccupation(chemin: string, lire: (c: string) => Statfs = statfsSync): { utilises: number; total: number } {
  const s = lire(chemin);
  const utilises = (s.blocks - s.bfree) * s.bsize;
  return { utilises, total: utilises + s.bavail * s.bsize };
}

interface Systeme {
  readdir: (d: string) => string[];
  lstat: (p: string) => { isDirectory(): boolean; size: number };
}
const SYSTEME: Systeme = { readdir: (d) => readdirSync(d), lstat: (p) => lstatSync(p) };
const absent = (e: unknown) => (e as { code?: string }).code === "ENOENT";

// Un journal recyclé entre la liste et la lecture n'est pas une erreur : on l'ignore.
export function tailleDossier(dossier: string, sys: Systeme = SYSTEME): number {
  let somme = 0;
  let noms: string[];
  try {
    noms = sys.readdir(dossier);
  } catch (e) {
    if (absent(e)) return 0;
    throw e;
  }
  for (const nom of noms) {
    const chemin = join(dossier, nom);
    try {
      const st = sys.lstat(chemin);
      somme += st.isDirectory() ? tailleDossier(chemin, sys) : st.size;
    } catch (e) {
      if (!absent(e)) throw e;
    }
  }
  return somme;
}
