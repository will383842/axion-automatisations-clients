import { readdirSync, statfsSync, statSync } from "node:fs";
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
export type Niveau = "rien" | "saturation_proche" | "plafond_atteint";
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
  if (niveau === "plafond_atteint") {
    const quand = depuis === undefined ? "" : ` depuis ${heure(depuis)}`;
    return `Archivage interrompu, la reprise à un instant précis n'est plus garantie${quand}. Disque des données à ${taux} %.`;
  }
  const fin = prevue === null ? "" : `, saturation prévue vers ${heure(prevue)}`;
  return `Disque des données à ${taux} %${fin}.`;
}

export function decider(mesures: Mesure[], p: Parametres, maintenant: number, etat: { dernierEchecArchivage?: number } = {}): Decision {
  const m = mesures[mesures.length - 1];
  if (!m) return { niveau: "rien", reveil: false, saturationPrevue: null, message: "" };
  const prevue = previsionSaturation(mesures);
  const reveil = prevue !== null && prevue - maintenant < p.horizonReveilMs;
  if (m.journauxEnAttente >= p.plafondJournaux) {
    return { niveau: "plafond_atteint", reveil: true, saturationPrevue: prevue, message: messageAlerte("plafond_atteint", m, prevue, etat.dernierEchecArchivage) };
  }
  if (m.utilises / m.total >= p.seuilAlerte || reveil) {
    return { niveau: "saturation_proche", reveil, saturationPrevue: prevue, message: messageAlerte("saturation_proche", m, prevue) };
  }
  return { niveau: "rien", reveil: false, saturationPrevue: prevue, message: "" };
}

// Lectures du système.
export function lireOccupation(chemin: string): { utilises: number; total: number } {
  const s = statfsSync(chemin);
  return { total: s.blocks * s.bsize, utilises: (s.blocks - s.bfree) * s.bsize };
}
export function tailleDossier(dossier: string): number {
  let somme = 0;
  for (const nom of readdirSync(dossier)) {
    const st = statSync(join(dossier, nom));
    somme += st.isDirectory() ? tailleDossier(join(dossier, nom)) : st.size;
  }
  return somme;
}
