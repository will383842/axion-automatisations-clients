import { readFileSync } from "node:fs";

// Versions des contrats, lues dans VERSION (lignes `nom=x.y.z`, commentaires `#`) : seule source de vérité.
export const CONTRATS = ["commun", "c1", "c2", "c3", "c4", "c5", "c6"] as const;
export type Contrat = (typeof CONTRATS)[number];
// Contrats gelés en 1.0.0 (T0-30, ADR 0033) : additifs seulement dans la 1.x, fixtures archivées dans fixtures-gelees/.
// C4 reste en 0.x jusqu'à sa révision ; C5 reste en 0.x tant que le job de CI `contrats-pg` n'existe pas (ADR 0031).
export const CONTRATS_GELES: readonly Contrat[] = ["commun", "c1", "c2", "c3", "c6"];

export function lireVersions(racine: string): Record<Contrat, string> {
  const versions: Record<string, string> = {};
  for (const ligne of readFileSync(`${racine}/VERSION`, "utf8").split("\n")) {
    const m = /^([a-z0-9]+)=((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.exec(ligne.trim());
    if (m) versions[m[1] as string] = m[2] as string;
  }
  for (const c of CONTRATS) if (!versions[c]) throw new Error(`VERSION : ${c} absent`);
  return versions as Record<Contrat, string>;
}
