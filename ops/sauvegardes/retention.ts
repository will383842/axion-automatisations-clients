import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Rétention des sauvegardes complètes (C-049) : 30 quotidiennes et 12 mensuelles. Calcul pur : aucune lecture de l'horloge ni du disque.
// Branchement : expirer.sh lit « pgbackrest info --output=json », passe la liste ici (commande en bas de ce fichier) puis
// fait expirer par pgBackRest (expire --set) exactement les ensembles que ce calcul désigne.
export interface Sauvegarde {
  id: string;
  date: string;
}
export interface Retention {
  quotidiennes: Sauvegarde[];
  mensuelles: Sauvegarde[];
  // Sauvegardes datées après la fin de « aujourd'hui » (horloge décalée, date locale au lieu d'UTC) : jamais expirées.
  futures: Sauvegarde[];
  garder: Sauvegarde[];
  expirer: Sauvegarde[];
}

const QUOTIDIENNES = 30;
const MENSUELLES = 12;
const JOUR = 86_400_000;

const horodatage = (s: Sauvegarde) => {
  const t = Date.parse(s.date);
  if (Number.isNaN(t)) throw new Error(`sauvegarde ${s.id} : date illisible « ${s.date} »`);
  return t;
};

// « aujourdhui » : AAAA-MM-JJ (UTC). Les quotidiennes sont la dernière sauvegarde de chacun des 30 derniers jours qui en ont une ;
// les mensuelles, la dernière de chacun des 12 derniers mois civils (le mois en cours compris) qui en ont une.
// Deux garde-fous : une sauvegarde datée après la fin du jour n'expire jamais, et la plus récente est toujours gardée
// (une horloge qui avance de plusieurs années ne doit pas faire expirer toute la rétention).
export function calculerRetention(sauvegardes: Sauvegarde[], aujourdhui: string): Retention {
  const fin = Date.parse(`${aujourdhui}T00:00:00Z`);
  if (Number.isNaN(fin)) throw new Error(`date du jour illisible « ${aujourdhui} »`);
  const finDuJour = fin + JOUR;
  const triees = [...sauvegardes].sort((a, b) => horodatage(a) - horodatage(b));
  const futures = triees.filter((s) => horodatage(s) >= finDuJour);
  const passees = triees.filter((s) => horodatage(s) < finDuJour);
  const dernierParCle = (cle: (s: Sauvegarde) => string) => {
    const m = new Map<string, Sauvegarde>();
    for (const s of passees) m.set(cle(s), s);
    return m;
  };
  const jour = (s: Sauvegarde) => new Date(horodatage(s)).toISOString().slice(0, 10);
  const mois = (s: Sauvegarde) => jour(s).slice(0, 7);

  const premierJour = fin - (QUOTIDIENNES - 1) * JOUR;
  const quotidiennes = [...dernierParCle(jour)]
    .filter(([j]) => Date.parse(`${j}T00:00:00Z`) >= premierJour && Date.parse(`${j}T00:00:00Z`) <= fin)
    .map(([, s]) => s);

  const d = new Date(fin);
  const premierMois = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (MENSUELLES - 1), 1)).toISOString().slice(0, 7);
  const dernierMois = d.toISOString().slice(0, 7);
  const mensuelles = [...dernierParCle(mois)].filter(([m]) => m >= premierMois && m <= dernierMois).map(([, s]) => s);

  const plusRecente = triees[triees.length - 1];
  const ids = new Set([...quotidiennes, ...mensuelles, ...futures, ...(plusRecente ? [plusRecente] : [])].map((s) => s.id));
  return {
    quotidiennes,
    mensuelles,
    futures,
    garder: triees.filter((s) => ids.has(s.id)),
    expirer: triees.filter((s) => !ids.has(s.id)),
  };
}

// Sauvegardes complètes lues dans la sortie de « pgbackrest info --output=json » (un tableau de grappes, chacune avec ses « backup »).
// Une forme inattendue lève une erreur : mieux vaut ne rien expirer que de se tromper.
export function completesDepuisInfo(json: string): Sauvegarde[] {
  const info: unknown = JSON.parse(json);
  if (!Array.isArray(info)) throw new Error("sortie de pgbackrest info : un tableau est attendu");
  const completes: Sauvegarde[] = [];
  for (const grappe of info as { backup?: unknown }[]) {
    if (!Array.isArray(grappe.backup)) throw new Error("sortie de pgbackrest info : liste « backup » absente");
    for (const b of grappe.backup as { label?: unknown; type?: unknown; timestamp?: { stop?: unknown } }[]) {
      if (b.type !== "full") continue;
      const arret = b.timestamp?.stop;
      if (typeof b.label !== "string" || typeof arret !== "number") throw new Error("sortie de pgbackrest info : sauvegarde sans label ou sans date d'arrêt");
      completes.push({ id: b.label, date: new Date(arret * 1000).toISOString() });
    }
  }
  return completes;
}

export function ensemblesAExpirer(infoJson: string, aujourdhui: string): string[] {
  return calculerRetention(completesDepuisInfo(infoJson), aujourdhui).expirer.map((s) => s.id);
}

// Commande : node retention.ts <AAAA-MM-JJ>   (la sortie de pgbackrest info arrive sur l'entrée standard ; un identifiant à expirer par ligne)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const aujourdhui = process.argv[2] ?? "";
    for (const id of ensemblesAExpirer(readFileSync(0, "utf8"), aujourdhui)) process.stdout.write(`${id}\n`);
  } catch (e) {
    process.stderr.write(`retention : ${(e as Error).message}\n`);
    process.exit(1);
  }
}
