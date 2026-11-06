import type { Sql } from "./etapes-base.js";

// Adaptateur Sql du provisionneur (dette T2-34) : sans valeurs, le texte part en protocole SIMPLE, qui accepte plusieurs ordres (SET ROLE …; REVOKE …; RESET ROLE) dans une seule
// transaction implicite ; avec des valeurs, protocole étendu (un seul ordre, valeurs jamais collées au texte). Un texte à plusieurs ordres avec des valeurs est refusé.
export function sqlPg(c: { query(texte: string, valeurs?: unknown[]): Promise<{ rows: unknown[] }> }): Sql {
  return {
    async requete<T>(texte: string, valeurs?: unknown[]): Promise<T[]> {
      if (!valeurs || valeurs.length === 0) return (await c.query(texte)).rows as T[];
      if (texte.replace(/;\s*$/, "").includes(";")) throw new Error("plusieurs ordres : valeurs refusées");
      return (await c.query(texte, valeurs)).rows as T[];
    },
  };
}
