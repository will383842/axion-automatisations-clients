// Limites de débit de chaque canal (T0-30). Au-delà : 429 `debit_depasse` avec l'en-tête Retry-After (obligatoire).
// `par` : ce qui est compté (la clé de signature X-Axion-Cle, ou l'adresse source pour C6 qui n'est pas signé par en-tête).
// `alerteRefusParMinute` : nombre de refus (429 et 401) en une minute qui déclenche une alerte de l'équipe.
export interface LimiteDebit {
  parMinute: number;
  alerteRefusParMinute: number;
  par: "cle" | "adresse";
}

export const LIMITES_DEBIT = {
  // C1 console → Hub : toutes les routes de la porte ensemble.
  c1: { parMinute: 60, alerteRefusParMinute: 10, par: "cle" },
  // C2 Hub → console : faits poussés (une boîte d'envoi qui se vide après une panne peut aller vite).
  c2: { parMinute: 120, alerteRefusParMinute: 10, par: "cle" },
  // C3 : un budget par sens, et un pour la lecture par SIREN.
  c3_crm_vers_console: { parMinute: 60, alerteRefusParMinute: 10, par: "cle" },
  c3_console_vers_crm: { parMinute: 60, alerteRefusParMinute: 10, par: "cle" },
  c3_lecture: { parMinute: 60, alerteRefusParMinute: 10, par: "cle" },
  // C4 : par clé de cellule, toutes les routes de l'exécuteur ensemble (paquets de 500 événements au plus).
  c4: { parMinute: 600, alerteRefusParMinute: 20, par: "cle" },
  // C6 : page d'entrée du lien signé, par adresse source.
  c6: { parMinute: 10, alerteRefusParMinute: 10, par: "adresse" },
} as const satisfies Record<string, LimiteDebit>;
export type CleLimite = keyof typeof LIMITES_DEBIT;

// Retry-After : nombre entier de secondes, de 1 à 60 (jamais une date).
export const RETRY_AFTER_MAX_SECONDES = 60;
export function entetesDebitDepasse(secondes: number): { "Retry-After": string } {
  if (!Number.isInteger(secondes) || secondes < 1 || secondes > RETRY_AFTER_MAX_SECONDES) throw new Error("Retry-After hors bornes");
  return { "Retry-After": String(secondes) };
}
