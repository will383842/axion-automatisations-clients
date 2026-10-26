// Coût d'IA provisoire (C-526) et mode d'IA par automatisation. Le public ne porte que le schéma et des valeurs d'EXEMPLE :
// les valeurs de travail sont dans le dépôt privé. Rien ici ne bloque un appel à cause d'un prix : un tableau incomplet donne un coût inconnu.

export type CodeCoutIa = "mode_ia_invalide";

export class ErreurCoutIa extends Error {
  constructor(readonly code: CodeCoutIa) {
    super(code);
    this.name = "ErreurCoutIa";
  }
}

export const MODES_IA = ["client_direct", "via_axion"] as const;
export type ModeIa = (typeof MODES_IA)[number];

// Le mode se choisit par automatisation, pas par client : aucune valeur par défaut.
export function lireModeIa(valeur: unknown): ModeIa {
  if (typeof valeur === "string" && (MODES_IA as readonly string[]).includes(valeur)) return valeur as ModeIa;
  throw new ErreurCoutIa("mode_ia_invalide");
}

export type StatutPrix = "PROVISOIRE" | "RELEVE";
export interface LigneCout { entree: number; sortie: number; statut: StatutPrix } // par million de jetons
export interface TableauCouts { statut: StatutPrix; lignes: Record<string, LigneCout> }

// Nombres ronds sans rapport avec un vrai prix.
export const TABLEAU_EXEMPLE: TableauCouts = {
  statut: "PROVISOIRE",
  lignes: {
    "claude-standard": { entree: 1, sortie: 1, statut: "PROVISOIRE" },
    "mistral-souverain": { entree: 1, sortie: 1, statut: "PROVISOIRE" },
    "gpt-option": { entree: 1, sortie: 1, statut: "PROVISOIRE" },
  },
};

export interface Usage { jetonsEntree: number; jetonsSortie: number }
export interface CoutAppel { cout: number; provisoire: boolean; inconnu?: true }

const jetonsOk = (n: number) => Number.isFinite(n) && n >= 0;

export function coutAppel(tableau: TableauCouts, modele: string, u: Usage): CoutAppel {
  const l = Object.hasOwn(tableau.lignes, modele) ? tableau.lignes[modele] : undefined;
  if (!l || !jetonsOk(u.jetonsEntree) || !jetonsOk(u.jetonsSortie)) return { cout: 0, provisoire: true, inconnu: true };
  return { cout: (u.jetonsEntree * l.entree + u.jetonsSortie * l.sortie) / 1_000_000, provisoire: l.statut === "PROVISOIRE" };
}

export type MotifBlocage = "appels_identiques" | "plafond_minute" | "plafond_heure" | "bloque";
export type Decision = { autorise: true } | { autorise: false; motif: MotifBlocage };

export interface OptionsGardeBoucle {
  identiquesMax: number;
  parMinuteMax: number;
  parHeureMax: number;
  horloge: () => number;
}

// Garde-fou anti-boucle : ne dépend ni du prix ni de la facturation, identique dans les deux modes.
// Un blocage dure jusqu'à lever(), que l'appelant réserve à un administrateur et trace au journal d'audit.
export function creerGardeBoucle(o: OptionsGardeBoucle) {
  const appels = new Map<string, number[]>();
  const derniere = new Map<string, { empreinte: string; n: number }>();
  const bloques = new Set<string>();
  return {
    verifier(_mode: ModeIa, automatisation: string, empreinte: string): Decision {
      if (bloques.has(automatisation)) return { autorise: false, motif: "bloque" };
      const t = o.horloge();
      const recents = (appels.get(automatisation) ?? []).filter((x) => t - x < 3_600_000);
      const d = derniere.get(automatisation);
      const n = d?.empreinte === empreinte ? d.n + 1 : 1;
      let motif: MotifBlocage | undefined;
      if (n >= o.identiquesMax) motif = "appels_identiques";
      else if (recents.filter((x) => t - x < 60_000).length >= o.parMinuteMax) motif = "plafond_minute";
      else if (recents.length >= o.parHeureMax) motif = "plafond_heure";
      if (motif === "appels_identiques") bloques.add(automatisation);
      if (motif) return { autorise: false, motif };
      appels.set(automatisation, [...recents, t]);
      derniere.set(automatisation, { empreinte, n });
      return { autorise: true };
    },
    lever(automatisation: string): void {
      bloques.delete(automatisation);
      derniere.delete(automatisation);
    },
  };
}
