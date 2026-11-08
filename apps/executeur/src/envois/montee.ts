// Montée des plafonds d'envoi d'une boîte (A-274) : 50 envois le premier jour, 300 le vingt-huitième et au-delà, palier linéaire.
// Les jours se comptent en date de Paris (Europe/Paris), jamais en UTC.
export const PLAFOND_DEPART = 50;
export const PLAFOND_MAX = 300;
export const JOURS_DE_MONTEE = 28;
// Valeurs [À DÉFINIR], réglables : après plus de 30 jours sans envoi, la boîte redescend de 7 jours de montée (consigné dans la PR).
export const SILENCE_JOURS = 30;
export const CRAN_JOURS = 7;

const FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
export const jourParis = (d: Date): string => FORMAT.format(d);

const MS_JOUR = 86_400_000;
const enJours = (jour: string) => Date.parse(`${jour}T00:00:00Z`) / MS_JOUR;
export const ecartJours = (de: string, a: string): number => Math.round(enJours(a) - enJours(de));
export const ajouterJours = (jour: string, n: number): string => new Date((enJours(jour) + n) * MS_JOUR).toISOString().slice(0, 10);

export function plafondDeMontee(numeroDeJour: number): number {
  const n = Math.min(Math.max(Math.trunc(numeroDeJour), 1), JOURS_DE_MONTEE);
  return PLAFOND_DEPART + Math.round(((PLAFOND_MAX - PLAFOND_DEPART) * (n - 1)) / (JOURS_DE_MONTEE - 1));
}

// Premier jour de montée à retenir : inchangé, sauf silence de plus de `silence` jours (la boîte reprend `cran` jours plus bas dans la montée, jamais sous le jour 1).
export function premierJourEffectif(premier: string, dernier: string | undefined, aujourdhui: string, silence = SILENCE_JOURS, cran = CRAN_JOURS): string {
  if (dernier === undefined || ecartJours(dernier, aujourdhui) <= silence) return premier;
  const indexAvant = Math.min(ecartJours(premier, dernier) + 1, JOURS_DE_MONTEE);
  return ajouterJours(aujourdhui, -(Math.max(1, indexAvant - cran) - 1));
}

// Premier instant du jour de Paris suivant (recherche dichotomique : le changement d'heure ne fausse rien).
export function minuitSuivant(maintenant: Date): number {
  const jour = jourParis(maintenant);
  let bas = maintenant.getTime();
  let haut = bas + 26 * 3_600_000;
  while (haut - bas > 1000) {
    const milieu = Math.floor((bas + haut) / 2);
    if (jourParis(new Date(milieu)) === jour) bas = milieu; else haut = milieu;
  }
  return haut;
}
