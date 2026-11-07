// Calculs du rapport mensuel (A-027, B-369, B-408) : fonctions PURES, depuis les agrégats seuls (aucun contenu, aucun coût).
// Toute entrée d'un autre client que celui du rapport fait échouer le calcul : rien n'est filtré en silence, rien n'est mélangé.
export interface AgregatJour { tenantId: string; jour: string; nombre: number; echecs: number }
export interface EntreeInstance {
  tenantId: string;
  code: string;
  libelle: string;
  // Minutes par élément du cadrage (C-241) de la version courante ; null = pas de cadrage. Jamais `minutes_gagnees`.
  minutesParElement: number | null;
  agregats: AgregatJour[];
}
export type Duree = { etat: "non_calcule" } | { etat: "mesure"; minutes: number };
export type Fiabilite = { etat: "sans_objet" } | { etat: "mesure"; pointsDeBase: number };
export type Comparaison = { etat: "sans_objet" } | { etat: "mesure"; ecartVolume: number; evolutionVolumePointsDeBase: number; ecartMinutes: number | null };
export interface MesuresInstance { code: string; libelle: string; volume: number; echecs: number; fiabilite: Fiabilite; heures: Duree; cumulHeures: Duree; comparaison: Comparaison }
export interface MesuresClient extends Omit<MesuresInstance, "code" | "libelle"> { mois: string; instances: MesuresInstance[]; instancesNonCalculees: number }

export class ErreurCalcul extends Error {}

const RE_MOIS = /^(\d{4})-(0[1-9]|1[0-2])$/;
const RE_JOUR = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function verifierMois(mois: string): [number, number] {
  const m = RE_MOIS.exec(mois);
  if (!m) throw new ErreurCalcul("mois_invalide");
  return [Number(m[1]), Number(m[2])];
}
const formaterMois = (an: number, mois: number): string => `${String(an).padStart(4, "0")}-${String(mois).padStart(2, "0")}`;
export function moisPrecedent(mois: string): string {
  const [an, m] = verifierMois(mois);
  return m === 1 ? formaterMois(an - 1, 12) : formaterMois(an, m - 1);
}
export function moisSuivant(mois: string): string {
  const [an, m] = verifierMois(mois);
  return m === 12 ? formaterMois(an + 1, 1) : formaterMois(an, m + 1);
}

export function formaterMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

const entierPositifOuNul = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

// Les jours sont des chaînes AAAA-MM-JJ : la comparaison lexicale suit l'ordre du calendrier.
function somme(agregats: AgregatJour[], debutInclus: string | null, finExclue: string): { volume: number; echecs: number } {
  let volume = 0;
  let echecs = 0;
  for (const a of agregats) {
    if (a.jour >= finExclue || (debutInclus !== null && a.jour < debutInclus)) continue;
    volume += a.nombre;
    echecs += a.echecs;
  }
  return { volume, echecs };
}

const cadrageValide = (m: number | null): m is number => m !== null && Number.isSafeInteger(m) && m > 0;
const duree = (volume: number, m: number | null): Duree => (cadrageValide(m) ? { etat: "mesure", minutes: volume * m } : { etat: "non_calcule" });

function fiabilite(volume: number, echecs: number): Fiabilite {
  if (volume === 0) return { etat: "sans_objet" };
  return { etat: "mesure", pointsDeBase: Math.floor(((volume - echecs) * 10_000 + volume / 2) / volume) };
}

function comparer(volume: number, precedent: number, heures: Duree, heuresPrecedentes: Duree): Comparaison {
  if (precedent === 0) return { etat: "sans_objet" }; // jamais de division par zéro ni de « +100 % »
  const ecartMinutes = heures.etat === "mesure" && heuresPrecedentes.etat === "mesure" ? heures.minutes - heuresPrecedentes.minutes : null;
  return { etat: "mesure", ecartVolume: volume - precedent, evolutionVolumePointsDeBase: Math.round(((volume - precedent) * 10_000) / precedent), ecartMinutes };
}

function verifier(tenantId: string, i: EntreeInstance): void {
  if (i.tenantId !== tenantId) throw new ErreurCalcul("instance_hors_client");
  for (const a of i.agregats) {
    if (a.tenantId !== tenantId) throw new ErreurCalcul("agregat_hors_client");
    if (!RE_JOUR.test(a.jour)) throw new ErreurCalcul("jour_invalide");
    if (!entierPositifOuNul(a.nombre) || !entierPositifOuNul(a.echecs) || a.echecs > a.nombre) throw new ErreurCalcul("agregat_invalide");
  }
}

function mesurerInstance(i: EntreeInstance, mois: string): MesuresInstance {
  const debut = `${mois}-01`;
  const suivant = `${moisSuivant(mois)}-01`;
  const precedent = `${moisPrecedent(mois)}-01`;
  const mesMois = somme(i.agregats, debut, suivant);
  const mesPrecedent = somme(i.agregats, precedent, debut);
  const depuisLeDebut = somme(i.agregats, null, suivant); // B-369 : tout jusqu'au dernier jour du mois inclus
  const heures = duree(mesMois.volume, i.minutesParElement);
  return {
    code: i.code, libelle: i.libelle, volume: mesMois.volume, echecs: mesMois.echecs, fiabilite: fiabilite(mesMois.volume, mesMois.echecs), heures,
    cumulHeures: duree(depuisLeDebut.volume, i.minutesParElement),
    comparaison: comparer(mesMois.volume, mesPrecedent.volume, heures, duree(mesPrecedent.volume, i.minutesParElement)),
  };
}

function totalDuree(l: Duree[]): Duree {
  const mesures = l.flatMap((d) => (d.etat === "mesure" ? [d.minutes] : []));
  return mesures.length === 0 ? { etat: "non_calcule" } : { etat: "mesure", minutes: mesures.reduce((a, b) => a + b, 0) };
}

export function calculerMesures(tenantId: string, instances: EntreeInstance[], mois: string): MesuresClient {
  verifierMois(mois);
  for (const i of instances) verifier(tenantId, i);
  const parInstance = instances.map((i) => mesurerInstance(i, mois));
  const volume = parInstance.reduce((a, i) => a + i.volume, 0);
  const echecs = parInstance.reduce((a, i) => a + i.echecs, 0);
  const heures = totalDuree(parInstance.map((i) => i.heures));
  // Mois précédent du client : recalculé sur les mêmes entrées (somme des instances calculables pour les minutes).
  const precedents = instances.map((i) => {
    const m = mesurerInstance(i, moisPrecedent(mois));
    return { volume: m.volume, heures: m.heures };
  });
  const volumePrecedent = precedents.reduce((a, p) => a + p.volume, 0);
  return {
    mois, volume, echecs, fiabilite: fiabilite(volume, echecs), heures, cumulHeures: totalDuree(parInstance.map((i) => i.cumulHeures)),
    comparaison: comparer(volume, volumePrecedent, heures, totalDuree(precedents.map((p) => p.heures))),
    instances: parInstance, instancesNonCalculees: parInstance.filter((i) => i.heures.etat === "non_calcule").length,
  };
}
