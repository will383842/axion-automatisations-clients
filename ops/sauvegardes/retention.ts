// Rétention des sauvegardes complètes (C-049) : 30 quotidiennes et 12 mensuelles. Fonction pure : aucune lecture de l'horloge ni du disque.
export interface Sauvegarde {
  id: string;
  date: string;
}
export interface Retention {
  quotidiennes: Sauvegarde[];
  mensuelles: Sauvegarde[];
  garder: Sauvegarde[];
  expirer: Sauvegarde[];
}

const QUOTIDIENNES = 30;
const MENSUELLES = 12;

const horodatage = (s: Sauvegarde) => {
  const t = Date.parse(s.date);
  if (Number.isNaN(t)) throw new Error(`sauvegarde ${s.id} : date illisible « ${s.date} »`);
  return t;
};

// « aujourdhui » : AAAA-MM-JJ (UTC). Les quotidiennes sont la dernière sauvegarde de chacun des 30 derniers jours qui en ont une ;
// les mensuelles, la dernière de chacun des 12 derniers mois civils (le mois en cours compris) qui en ont une.
export function calculerRetention(sauvegardes: Sauvegarde[], aujourdhui: string): Retention {
  const fin = Date.parse(`${aujourdhui}T00:00:00Z`);
  if (Number.isNaN(fin)) throw new Error(`date du jour illisible « ${aujourdhui} »`);
  const triees = [...sauvegardes].sort((a, b) => horodatage(a) - horodatage(b));
  const dernierParCle = (cle: (s: Sauvegarde) => string) => {
    const m = new Map<string, Sauvegarde>();
    for (const s of triees) m.set(cle(s), s);
    return m;
  };
  const jour = (s: Sauvegarde) => new Date(horodatage(s)).toISOString().slice(0, 10);
  const mois = (s: Sauvegarde) => jour(s).slice(0, 7);

  const premierJour = fin - (QUOTIDIENNES - 1) * 86_400_000;
  const quotidiennes = [...dernierParCle(jour)]
    .filter(([j]) => Date.parse(`${j}T00:00:00Z`) >= premierJour && Date.parse(`${j}T00:00:00Z`) <= fin)
    .map(([, s]) => s);

  const d = new Date(fin);
  const premierMois = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (MENSUELLES - 1), 1)).toISOString().slice(0, 7);
  const dernierMois = d.toISOString().slice(0, 7);
  const mensuelles = [...dernierParCle(mois)].filter(([m]) => m >= premierMois && m <= dernierMois).map(([, s]) => s);

  // Une date d'après aujourd'hui (décalage d'horloge, date locale au lieu d'UTC) n'est jamais à expirer : on ne détruit pas ce qu'on ne sait pas dater.
  const futures = triees.filter((s) => horodatage(s) >= fin + 86_400_000);
  const ids = new Set([...quotidiennes, ...mensuelles, ...futures].map((s) => s.id));
  return {
    quotidiennes,
    mensuelles,
    garder: triees.filter((s) => ids.has(s.id)),
    expirer: triees.filter((s) => !ids.has(s.id)),
  };
}
