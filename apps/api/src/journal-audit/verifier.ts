import { empreinteDe, type LigneJournal } from "./contenu-canonique.js";

// Vérification de la chaîne du journal d'audit (A-182, C-028) : chaque empreinte est recalculée de bout en bout, hors de la base.
// Lecture par lots de 1 000 dans l'ordre des identifiants. Un trou d'identifiants (transaction annulée) est accepté : seule la chaîne compte.
export const TAILLE_LOT = 1000;

export interface LecteurJournal {
  // Lignes d'identifiant strictement supérieur à `apres` (toutes si null), dans l'ordre, au plus `limite`.
  lireLot(apres: string | null, limite: number): Promise<LigneJournal[]>;
  // Lignes créées dans [debut, fin[ (dates au format AAAA-MM-JJTHH:MM:SS.UUUUUUZ), dans l'ordre.
  lireIntervalle(debut: string, fin: string): Promise<LigneJournal[]>;
}
export type Requete = (sql: string, valeurs: unknown[]) => Promise<Record<string, unknown>[]>;
export interface Tete { id: string; empreinte: string }
export type Verification =
  | { intacte: true; lignes: number; tete: Tete | null }
  | { intacte: false; rupture: { id: string; attendu: string | null; trouve: string | null } };

// ORDER BY désigne d'abord la colonne de SORTIE : `id::text AS id` trierait en alphabétique (1, 10, 100, 2…). On trie donc sur `journal_audit.id` (bigint de la table).
// La table lue est un paramètre pour qu'un essai vérifie une copie ; le nom est un identifiant SQL contrôlé, jamais une entrée d'utilisateur.
const SOURCE = /^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$/;
export const COLONNES = `id::text AS id, tenant_id::text AS tenant_id, acteur, action::text AS action, entite, entite_id, ancienne::text AS ancienne, nouvelle::text AS nouvelle,
  abbrev(ip) AS ip, to_char(cree_le AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cree, empreinte_precedente, empreinte`;

export function lecteurSql(requete: Requete, source = "public.journal_audit"): LecteurJournal {
  if (!SOURCE.test(source)) throw new Error("source du journal invalide");
  return {
    async lireLot(apres, limite) {
      return (await requete(`SELECT ${COLONNES} FROM ${source} AS journal_audit WHERE ($1::bigint IS NULL OR journal_audit.id > $1::bigint) ORDER BY journal_audit.id LIMIT $2`, [apres, limite])) as unknown as LigneJournal[];
    },
    async lireIntervalle(debut, fin) {
      return (await requete(`SELECT ${COLONNES} FROM ${source} AS journal_audit WHERE cree_le >= $1::timestamptz AND cree_le < $2::timestamptz ORDER BY journal_audit.id`, [debut, fin])) as unknown as LigneJournal[];
    },
  };
}

// `depuis` : la dernière tête déjà vérifiée et copiée hors de la base ; la suite doit s'y accrocher. Renvoie la première rupture :
// ligne retirée ou intercalée (précédente ≠ empreinte de la ligne d'avant), ligne modifiée (empreinte ≠ recalcul).
export async function verifierChaine(lecteur: LecteurJournal, depuis?: Tete): Promise<Verification> {
  let tete: Tete | null = depuis ?? null;
  let lignes = 0;
  for (;;) {
    const lot = await lecteur.lireLot(tete?.id ?? null, TAILLE_LOT);
    for (const l of lot) {
      const avant = tete?.empreinte ?? null;
      if ((l.empreinte_precedente ?? null) !== avant) return { intacte: false, rupture: { id: l.id, attendu: avant, trouve: l.empreinte_precedente ?? null } };
      const attendu = empreinteDe(avant, l);
      if (l.empreinte !== attendu) return { intacte: false, rupture: { id: l.id, attendu, trouve: l.empreinte } };
      tete = { id: l.id, empreinte: l.empreinte };
      lignes++;
    }
    if (lot.length < TAILLE_LOT) return { intacte: true, lignes, tete };
  }
}

