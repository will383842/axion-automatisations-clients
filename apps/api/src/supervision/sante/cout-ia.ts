// Coût d'IA (B-386) : toujours en micro-centimes entiers. Le budget du client vient d'un port (volume effectif, fixture tant que T7-35 n'est pas fusionnée).
export interface LigneCoutIa {
  jour: string; // AAAA-MM-JJ
  coutMicroCentimes: number;
}

function somme(lignes: LigneCoutIa[], garde: (jour: string) => boolean): number {
  let total = 0;
  for (const l of lignes) {
    if (!Number.isSafeInteger(l.coutMicroCentimes) || l.coutMicroCentimes < 0) throw new Error("cout_non_entier");
    if (garde(l.jour)) total += l.coutMicroCentimes;
  }
  return total;
}
const jourDe = (d: Date) => d.toISOString().slice(0, 10);

export const coutIaDuJour = (lignes: LigneCoutIa[], maintenant: Date) => somme(lignes, (j) => j === jourDe(maintenant));
export const coutIaDuMois = (lignes: LigneCoutIa[], maintenant: Date) => somme(lignes, (j) => j.slice(0, 7) === jourDe(maintenant).slice(0, 7));

/** Points de base du budget consommés (10 000 = 100 %), ou null sans budget. */
export function pourcentBudget(coutMicroCentimes: number, budgetMicroCentimes: number): number | null {
  if (budgetMicroCentimes <= 0) return null;
  return Math.floor((coutMicroCentimes * 10_000) / budgetMicroCentimes);
}
