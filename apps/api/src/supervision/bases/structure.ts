// Version de structure d'une base (B-388) : la plus haute ligne de public.version_structure donne « modele_vN » (A-225).
const FORME = /^modele_v(\d{1,6})$/;

export const codeVersion = (versions: number[]): string => `modele_v${versions.length ? Math.max(...versions) : 0}`;

function numero(code: string): number {
  const m = FORME.exec(code);
  if (!m) throw new Error(`version de structure illisible : ${code}`);
  return Number(m[1]);
}

// En retard = une vague vise une version plus haute que celle de la base. Sans vague en cours, aucune base n'est en retard.
export function baseEnRetard(versionBase: string, versionVague: string | null): boolean {
  const base = numero(versionBase);
  return versionVague !== null && base < numero(versionVague);
}
