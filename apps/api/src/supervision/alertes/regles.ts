// Règles d'alertes réglables par l'équipe (T5-04c, B-031) : gravité, seuil, fenêtre, activation. Jamais le code de la règle.
// Le journal est écrit par le déclencheur d'audit de l'équipe : rien à tracer à la main ici.
export const GRAVITES_REGLE = ["information", "avertissement", "critique"] as const;
export interface Regle {
  id: string;
  code: string;
  gravite: string;
  seuil: number;
  fenetre_s: number;
  active: boolean;
}
export interface ReglageRegle {
  gravite?: (typeof GRAVITES_REGLE)[number] | undefined;
  seuil?: number | undefined;
  fenetre_s?: number | undefined;
  active?: boolean | undefined;
}
export class ErreurRegles extends Error {
  constructor(readonly code: "champ_inconnu" | "valeur_invalide") {
    super(code);
    this.name = "ErreurRegles";
  }
}
export interface DepotRegles {
  regler(id: string, reglage: ReglageRegle, acteur: string): Promise<Regle | null>;
}

const CHAMPS = ["gravite", "seuil", "fenetre_s", "active"] as const; // ordre fixe des colonnes du SET

// Validation avant toute requête : champ hors liste ou réglage vide → champ_inconnu ; valeur hors bornes (de la base : seuil >= 0, fenêtre > 0) → valeur_invalide.
export async function reglerRegle(depot: DepotRegles, id: string, reglage: ReglageRegle, acteur: string): Promise<Regle | null> {
  const cles = Object.keys(reglage);
  if (cles.length === 0 || cles.some((c) => !(CHAMPS as readonly string[]).includes(c))) throw new ErreurRegles("champ_inconnu");
  const { gravite, seuil, fenetre_s, active } = reglage;
  if (gravite !== undefined && !(GRAVITES_REGLE as readonly string[]).includes(gravite)) throw new ErreurRegles("valeur_invalide");
  if (seuil !== undefined && !(Number.isInteger(seuil) && seuil >= 0)) throw new ErreurRegles("valeur_invalide");
  if (fenetre_s !== undefined && !(Number.isInteger(fenetre_s) && fenetre_s > 0)) throw new ErreurRegles("valeur_invalide");
  if (active !== undefined && typeof active !== "boolean") throw new ErreurRegles("valeur_invalide");
  return depot.regler(id, reglage, acteur);
}

type Requete = { query(texte: string, params: unknown[]): Promise<{ rows: unknown[] }> };
// `transaction` : transaction d'équipe injectée par l'appelant (acteur tracé par le déclencheur d'audit).
export function depotSqlRegles(transaction: <T>(acteur: string, fn: (q: Requete) => Promise<T>) => Promise<T>): DepotRegles {
  return {
    regler: (id, reglage, acteur) =>
      transaction(acteur, async (q) => {
        const fixes = CHAMPS.filter((c) => reglage[c] !== undefined);
        const sets = fixes.map((c, i) => `${c} = $${i + 2}`).join(", ");
        const r = await q.query(`UPDATE regles_alertes SET ${sets} WHERE id = $1 RETURNING id, code, gravite, seuil, fenetre_s, active`, [id, ...fixes.map((c) => reglage[c])]);
        return (r.rows[0] as Regle | undefined) ?? null;
      }),
  };
}
