// Dépôt des outils du client et du catalogue (T3-17b) : trois requêtes CONSTANTES sous console_equipe, colonnes nommées, jamais « * ».
// console_equipe voit tous les clients : le filtre tenant_id = $1 est la seconde barrière d'isolation (la première est exigerDroit).
export interface Tx { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface OutilBrut { famille: string; outil: string; cree_le: string | null }
export interface AutomatisationCatalogue { code: string; nom: string; familles: string[] }
export interface Connecteur { famille: string; outil: string }
export interface DepotOutils {
  outils(clientId: string): Promise<OutilBrut[]>;
  catalogue(): Promise<AutomatisationCatalogue[]>;
  connecteurs(): Promise<Connecteur[]>;
}

export const SQL_OUTILS = "SELECT famille, outil, cree_le FROM outils_client WHERE tenant_id = $1 ORDER BY famille, outil";
// Les familles sont extraites dans SQL : le manifeste entier n'est jamais lu. Version publiée la plus récente de chaque automatisation au catalogue.
export const SQL_CATALOGUE =
  "SELECT a.code AS code, a.nom AS nom, coalesce(v.familles, '[]'::jsonb) AS familles " +
  "FROM automatisations a LEFT JOIN LATERAL (SELECT jsonb_path_query_array(vv.manifeste, '$.connecteurs[*].famille') AS familles FROM versions_automatisation vv WHERE vv.automatisation_id = a.id AND vv.statut = 'publiee' ORDER BY vv.cree_le DESC, vv.id LIMIT 1) v ON true " +
  "WHERE a.statut = 'au_catalogue' ORDER BY a.code";
export const SQL_CONNECTEURS = "SELECT DISTINCT famille, outil FROM connecteurs ORDER BY famille, outil";

// Minute en UTC (2026-11-07T08:42Z) ; null reste null ; toujours passé par Date.
export function minuteUtc(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(0, 16)}Z`;
}
const texte = (v: unknown): string => (typeof v === "string" ? v : "");

export function creerDepotOutils(tx: Tx): DepotOutils {
  return {
    async outils(clientId) {
      return (await tx.query(SQL_OUTILS, [clientId])).rows.map((r) => ({ famille: texte(r["famille"]), outil: texte(r["outil"]), cree_le: minuteUtc(r["cree_le"]) }));
    },
    async catalogue() {
      return (await tx.query(SQL_CATALOGUE)).rows.map((r) => ({ code: texte(r["code"]), nom: texte(r["nom"]), familles: Array.isArray(r["familles"]) ? r["familles"].filter((f): f is string => typeof f === "string") : [] }));
    },
    async connecteurs() {
      return (await tx.query(SQL_CONNECTEURS)).rows.map((r) => ({ famille: texte(r["famille"]), outil: texte(r["outil"]) }));
    },
  };
}
