import { readFileSync, readdirSync } from "node:fs";

// Partition du projet « integration » en fragments de charge estimée égale (ADR 0121, qui complète l'ADR 0118).
// Remplace `--shard` de Vitest, qui trie par empreinte du chemin sans tenir compte des durées.
// Chaque fichier va dans UN seul fragment ; l'ensemble des fragments est exactement l'ensemble des fichiers *.int.test.ts.

/** Nombre de fragments du socle d'intégration : un job `fragment-N` par valeur dans .github/workflows/socle-integration.yml. */
export const FRAGMENTS_INTEGRATION = 4;

export type Poids = { defaut: number; fichiers: Record<string, number>; separes?: string[][] };

const IGNORES = new Set(["node_modules", ".git", "dist", ".next", "__fixtures__"]);

/** Tous les fichiers d'intégration du dépôt, chemins relatifs à la racine, triés. */
export function fichiersIntegration(racine = "."): string[] {
  const trouves: string[] = [];
  const parcourir = (rel: string): void => {
    for (const e of readdirSync(rel === "" ? racine : `${racine}/${rel}`, { withFileTypes: true })) {
      const chemin = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!IGNORES.has(e.name)) parcourir(chemin);
      } else if (e.name.endsWith(".int.test.ts")) trouves.push(chemin);
    }
  };
  parcourir("");
  return trouves.sort();
}

export function lirePoids(chemin = "ops/socle/poids-integration.json"): Poids {
  const brut = JSON.parse(readFileSync(chemin, "utf8")) as Partial<Poids>;
  if (typeof brut.defaut !== "number" || !(brut.defaut > 0)) throw new Error(`${chemin} : poids par défaut absent ou non positif`);
  return { defaut: brut.defaut, fichiers: brut.fichiers ?? {}, separes: brut.separes ?? [] };
}

export const poidsDe = (f: string, p: Poids): number => p.fichiers[f] ?? p.defaut;
export const charge = (fichiers: string[], p: Poids): number => fichiers.reduce((s, f) => s + poidsDe(f, p), 0);

/** Glouton : le fichier le plus lourd d'abord, dans le fragment le moins chargé. Déterministe (égalités : ordre du groupe « separes », puis chemin).
 *  Un fichier d'un groupe « separes » évite, tant que possible, les fragments qui contiennent déjà un autre fichier du même groupe. */
export function partitionner(fichiers: string[], n: number, p: Poids): string[][] {
  const parts: string[][] = Array.from({ length: n }, () => []);
  const charges: number[] = Array(n).fill(0);
  const groupes = p.separes ?? [];
  const rang = (f: string): number => Math.max(...groupes.map((g) => g.indexOf(f)));
  const ordre = [...fichiers].sort((a, b) => poidsDe(b, p) - poidsDe(a, p) || rang(a) - rang(b) || (a < b ? -1 : 1));
  for (const f of ordre) {
    const freres = groupes.filter((g) => g.includes(f)).flat();
    const libres = parts.map((x, i) => i).filter((i) => !parts[i]?.some((g) => freres.includes(g)));
    const candidats = libres.length ? libres : parts.map((_, i) => i);
    let k = candidats[0] ?? 0;
    for (const i of candidats) if ((charges[i] ?? 0) < (charges[k] ?? 0)) k = i;
    parts[k]?.push(f);
    charges[k] = (charges[k] ?? 0) + poidsDe(f, p);
  }
  return parts.map((x) => x.sort());
}

/** Fichiers d'un fragment, depuis la valeur « i/n » de FRAGMENT_INTEGRATION. Toute valeur invalide lève une erreur (jamais « tout lancer »). */
export function fichiersDuFragment(valeur: string): string[] {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(valeur);
  const i = Number(m?.[1]);
  if (!m || Number(m[2]) !== FRAGMENTS_INTEGRATION || i > FRAGMENTS_INTEGRATION) throw new Error(`FRAGMENT_INTEGRATION invalide : « ${valeur} » (attendu 1/${FRAGMENTS_INTEGRATION} à ${FRAGMENTS_INTEGRATION}/${FRAGMENTS_INTEGRATION})`);
  return partitionner(fichiersIntegration(), FRAGMENTS_INTEGRATION, lirePoids())[i - 1] ?? [];
}
