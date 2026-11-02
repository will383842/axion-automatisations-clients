import { contexteChamp, type creerColonnesChiffrees } from "./colonnes-chiffrees.js";
import type { ClientSql } from "./personnes-chiffrees.js";

// Balayage des champs et objets chiffrés d'un client (A-201, A-243) : après une rotation de sa clé, chaque clé de données est réenveloppée
// avec la version courante ; les anciens chiffrés (contexte en tête du clair, format 1) sont repris au format 2 (contexte dans l'AAD).
// Garanties :
//   - aucune donnée n'est supprimée ni écrite en clair : un élément n'est remplacé que par son résultat relu et trouvé égal (colonnes.reprendre) ;
//   - le remplacement se fait par comparaison avec l'ancienne valeur : une écriture concurrente n'est jamais écrasée (compté en conflit, repris au passage suivant) ;
//   - rejouable : un élément à jour n'est pas réécrit ; un passage interrompu reprend à son curseur (`reprise`) ;
//   - borné : lots d'au plus 10 000 éléments, nombre de lots plafonné par `maxLots`.
// Un élément illisible ou en échec est compté, jamais remplacé, et le balayage continue. Aucune valeur ni identifiant n'est écrit dans une erreur.

export interface ElementChiffre {
  id: string; // identifiant stable dans la source (ordre croissant)
  contexte: string; // contexte lié au chiffré : contexteChamp(...) ou contexteFichier(...)
  octets: Uint8Array;
}

export interface SourceChiffres {
  /** Lot d'au plus `taille` éléments d'identifiant strictement supérieur à `curseur` ; `suivant` absent quand il n'y en a plus. */
  lire(tenantId: string, curseur: string | undefined, taille: number): Promise<{ elements: ElementChiffre[]; suivant?: string | undefined }>;
  /** Remplace seulement si la valeur actuelle est encore `ancien` ; rend false sinon. */
  remplacer(tenantId: string, id: string, ancien: Uint8Array, nouveau: Uint8Array): Promise<boolean>;
}

/** Par source : curseur du dernier lot lu, ou null si la source est terminée. Absente : départ. */
export type Reprise = Record<string, string | null>;

export interface BilanBalayage {
  examines: number;
  reenveloppes: number;
  migres: number;
  dejaAJour: number;
  conflits: number;
  echecs: number;
  termine: boolean;
  reprise: Reprise;
}

const TAILLE_MAX = 10_000;
const entier = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

export async function balayer(
  o: { colonnes: Pick<ReturnType<typeof creerColonnesChiffrees>, "reprendre">; sources: Record<string, SourceChiffres> },
  tenantId: string,
  opt: { taille?: number; maxLots?: number; reprise?: Reprise } = {},
): Promise<BilanBalayage> {
  const taille = opt.taille ?? 100;
  const maxLots = opt.maxLots ?? Number.MAX_SAFE_INTEGER;
  if (!entier(taille, TAILLE_MAX) || !entier(maxLots, Number.MAX_SAFE_INTEGER)) throw new Error("balayage_invalide");
  const reprise: Reprise = { ...opt.reprise };
  const bilan: BilanBalayage = { examines: 0, reenveloppes: 0, migres: 0, dejaAJour: 0, conflits: 0, echecs: 0, termine: false, reprise };
  let lots = 0;
  for (const [nom, source] of Object.entries(o.sources).sort(([a], [b]) => a.localeCompare(b))) {
    while (reprise[nom] !== null) {
      if (lots >= maxLots) return bilan;
      lots++;
      const lot = await source.lire(tenantId, reprise[nom], taille);
      for (const e of lot.elements) {
        bilan.examines++;
        try {
          const r = await o.colonnes.reprendre(tenantId, e.octets, e.contexte);
          if (r.etat === "a_jour") bilan.dejaAJour++;
          else if (!(await source.remplacer(tenantId, e.id, e.octets, r.octets))) bilan.conflits++;
          else if (r.etat === "migre") bilan.migres++;
          else bilan.reenveloppes++;
        } catch {
          bilan.echecs++;
        }
      }
      reprise[nom] = lot.suivant === undefined || lot.elements.length === 0 ? null : lot.suivant;
    }
  }
  bilan.termine = bilan.echecs === 0 && bilan.conflits === 0;
  return bilan;
}

const FORME_TABLE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const FORME_COLONNE = /^[a-z][a-z0-9_]*$/;

/**
 * Source SQL : les colonnes bytea chiffrées d'une table à clé `id` (uuid) de la base du client. Identifiants SQL validés (jamais d'entrée libre) ;
 * valeurs paramétrées. Un lot par colonne et par curseur d'identifiant ; l'identifiant d'élément est « <colonne>:<idLigne> ».
 */
export function sourceColonnesSql(sql: ClientSql, table: string, colonnes: string[]): SourceChiffres {
  if (!FORME_TABLE.test(table) || colonnes.length === 0 || !colonnes.every((c) => FORME_COLONNE.test(c))) throw new Error("balayage_invalide");
  const nomTable = table.split(".")[1] as string;
  // Curseur « <indice de colonne>:<idLigne> » : toutes les lignes d'une colonne, puis la suivante.
  const separer = (id: string) => ({ colonne: id.slice(0, id.indexOf(":")), idLigne: id.slice(id.indexOf(":") + 1) });
  return {
    async lire(_t, curseur, taille) {
      let i = curseur === undefined ? 0 : colonnes.indexOf(separer(curseur).colonne);
      let apres = curseur === undefined ? null : separer(curseur).idLigne;
      if (i < 0) throw new Error("balayage_invalide");
      for (; i < colonnes.length; i++, apres = null) {
        const c = colonnes[i] as string;
        const r = await sql.query(`SELECT id, ${c} AS valeur FROM ${table} WHERE ${c} IS NOT NULL AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`, [apres, taille]);
        if (r.rows.length === 0) continue;
        const elements = r.rows.map((l) => ({ id: `${c}:${String(l["id"])}`, contexte: contexteChamp({ colonne: `${nomTable}.${c}`, idLigne: String(l["id"]) }), octets: l["valeur"] as Uint8Array }));
        return { elements, suivant: elements[elements.length - 1]?.id };
      }
      return { elements: [] };
    },
    async remplacer(_t, id, ancien, nouveau) {
      const { colonne, idLigne } = separer(id);
      if (!colonnes.includes(colonne)) throw new Error("balayage_invalide");
      const r = await sql.query(`UPDATE ${table} SET ${colonne} = $3 WHERE id = $1::uuid AND ${colonne} = $2 RETURNING id`, [idLigne, ancien, nouveau]);
      return r.rows.length === 1;
    },
  };
}
