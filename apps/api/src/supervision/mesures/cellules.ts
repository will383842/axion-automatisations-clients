// Signal de vie d'une cellule (B-384) : file d'attente, travaux en cours, processeur. Une cellule muette depuis 10 minutes est marquée muette.
export const MUETTE_APRES_MS = 600_000;

export interface SignalCellule {
  code: string;
  recuLe: Date | null;
  fileAttente?: number;
  travauxEnCours?: number;
  processeurPourcent?: number;
}
export interface EtatCellule {
  code: string;
  muette: boolean;
  fileAttente?: number;
  travauxEnCours?: number;
  processeurPourcent?: number;
}

export function etatCellule(s: SignalCellule, maintenant: Date): EtatCellule {
  const muette = s.recuLe === null || maintenant.getTime() - s.recuLe.getTime() >= MUETTE_APRES_MS;
  if (s.recuLe === null) return { code: s.code, muette };
  const { fileAttente, travauxEnCours, processeurPourcent } = s;
  return { code: s.code, muette, ...(fileAttente !== undefined && { fileAttente }), ...(travauxEnCours !== undefined && { travauxEnCours }), ...(processeurPourcent !== undefined && { processeurPourcent }) };
}
