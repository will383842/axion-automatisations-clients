// Requêtes lentes d'une base (A-197) : on range le COMPTE et les identifiants de requête, jamais le texte (il peut contenir des valeurs littérales).
// La colonne `query` n'est jamais sélectionnée par la relève.
export const SQL_REQUETES_LENTES = "SELECT queryid::text AS queryid, calls::bigint AS calls, mean_exec_time FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())";
export const SQL_SUIVI = "SELECT current_setting('pg_stat_statements.track', true) AS suivi";

export const suiviAutorise = (valeur: string | null | undefined): boolean => valeur === "top" || valeur === "all";

export interface LigneStatement {
  queryid: string;
  calls: number;
  mean_exec_time: number;
}

export function compterLentes(lignes: LigneStatement[], seuilMs: number, suivi: string = "top"): { nombre: number; identifiants: string[] } {
  if (!suiviAutorise(suivi)) throw new Error("suivi des requêtes inactif (pg_stat_statements.track) : relève refusée");
  const identifiants = lignes.filter((l) => l.mean_exec_time > seuilMs).map((l) => l.queryid);
  return { nombre: identifiants.length, identifiants };
}
