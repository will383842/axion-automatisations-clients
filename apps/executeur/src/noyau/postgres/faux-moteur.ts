import type { Pool } from "pg";
import { CoupureProcessus } from "../ports.ts";

// Imitation minimale de la base moteur pour les tests ordinaires : les transactions sont copiées au BEGIN et reprises au COMMIT.
// Elle ne comprend que les requêtes des adaptateurs PostgreSQL (reconnues par leur début) ; la vraie base est essayée dans les *.int.test.ts.
export interface Etat {
  executions: { id: string; instanceId: string; debut: Date }[];
  intentions: { cle: string; executionId: string; garantie: string; etat: string; creeLe?: number }[];
  journal: { executionId: string; etape: string; cle: string; statut: string; creeLe: Date }[];
  curseurs: { instanceId: string; declencheur: string; valeur: string }[];
}

// Ne rend que les colonnes demandées par le SELECT : une colonne oubliée dans la requête de l'adaptateur doit se voir.
function colonnes(sql: string, ligne: Record<string, unknown>): Record<string, unknown> {
  const liste = /^SELECT (.+?) FROM /.exec(sql)?.[1] ?? "";
  const noms = liste.split(",").map((c) => c.trim().replace(/^\w+\./, ""));
  return Object.fromEntries(noms.filter((n) => n in ligne).map((n) => [n, ligne[n]]));
}

export class FauxMoteur {
  etat: Etat = { executions: [], intentions: [], journal: [], curseurs: [] };
  requetes: string[] = [];
  // Nombre de requêtes avant la mort du processus (undefined : jamais) ; les suivantes lèvent CoupureProcessus.
  mortApres: number | undefined;
  // Début de requête qui tue le processus (avant son effet).
  mortSur: string | undefined;
  // Erreur levée une seule fois, par la première requête qui commence ainsi (ex. panne PgBouncer en pleine mise à jour).
  erreurSur: { debut: string; erreur: unknown } | undefined;
  // Instant (ms) posé sur chaque intention créée : à régler comme l'horloge du test.
  maintenant = 1_000_000;
  #vues = 0;
  #horloge = 0;

  ouvrirExecution(instanceId: string, executionId: string) {
    this.etat.executions.push({ id: executionId, instanceId, debut: new Date(Date.UTC(2026, 10, 1)) });
  }
  // Un nouveau processus : le compteur repart, la base garde ce qui était validé.
  redemarrer(mortApres?: number) {
    this.#vues = 0;
    this.mortApres = mortApres;
  }
  get requetesVues() {
    return this.#vues;
  }

  pool(): Pool {
    return {
      connect: async () => {
        let copie: Etat | undefined;
        return {
          release: () => undefined,
          query: async (texte: string, params: unknown[] = []) => {
            const sql = texte.replace(/\s+/g, " ").trim();
            this.requetes.push(sql);
            if (this.mortSur && sql.startsWith(this.mortSur)) throw new CoupureProcessus();
            if (this.erreurSur && sql.startsWith(this.erreurSur.debut)) {
              const { erreur } = this.erreurSur;
              this.erreurSur = undefined;
              throw erreur;
            }
            if (this.mortApres !== undefined && this.#vues >= this.mortApres) throw new CoupureProcessus();
            this.#vues++;
            if (sql === "BEGIN") {
              copie = structuredClone(this.etat);
              return { rows: [], rowCount: 0 };
            }
            if (sql === "COMMIT") {
              if (copie) this.etat = copie;
              copie = undefined;
              return { rows: [], rowCount: 0 };
            }
            if (sql === "ROLLBACK") {
              copie = undefined;
              return { rows: [], rowCount: 0 };
            }
            const e = copie ?? this.etat;
            return this.#executer(e, sql, params);
          },
        };
      },
    } as unknown as Pool;
  }

  #executer(e: Etat, sql: string, p: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    const rien = { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT set_config")) return rien;
    if (sql.startsWith("SELECT debut FROM executions")) {
      const x = e.executions.find((v) => v.id === p[1] && v.instanceId === p[2]);
      return x ? { rows: [{ debut: x.debut }], rowCount: 1 } : rien;
    }
    if (sql.startsWith("INSERT INTO intentions")) {
      if (e.intentions.some((v) => v.cle === p[3])) return rien;
      e.intentions.push({ cle: p[3] as string, executionId: p[1] as string, garantie: p[4] as string, etat: "ecrite", creeLe: this.maintenant });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT etat, garantie")) {
      const x = e.intentions.find((v) => v.cle === p[1]);
      if (!x) return rien;
      const ligne = { etat: x.etat, garantie: x.garantie, execution_id: x.executionId, cree_le: new Date(x.creeLe ?? 0) };
      return { rows: [colonnes(sql, ligne)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE intentions SET etat")) {
      const x = e.intentions.find((v) => v.cle === p[1] && v.etat === "ecrite");
      if (!x) return rien;
      x.etat = p[2] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO journal_etape")) {
      if (e.journal.some((v) => v.executionId === p[1] && v.etape === p[3] && v.cle === p[4])) return rien;
      e.journal.push({ executionId: p[1] as string, etape: p[3] as string, cle: p[4] as string, statut: "en_cours", creeLe: new Date(Date.UTC(2026, 10, 1, 0, 0, this.#horloge++)) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE journal_etape SET statut")) {
      const x = e.journal.find((v) => v.executionId === p[1] && v.etape === p[2] && v.cle === p[3]);
      if (!x) return rien;
      x.statut = p[4] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT j.etape")) {
      const rows = e.journal.filter((v) => v.executionId === p[1]).map((v) => ({ etape: v.etape, cle: v.cle, statut: v.statut, cree_le: v.creeLe }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT valeur FROM curseurs")) {
      const x = e.curseurs.find((v) => v.instanceId === p[1] && v.declencheur === p[2]);
      return x ? { rows: [{ valeur: x.valeur }], rowCount: 1 } : rien;
    }
    if (sql.startsWith("INSERT INTO curseurs")) {
      const x = e.curseurs.find((v) => v.instanceId === p[1] && v.declencheur === p[2]);
      if (x) x.valeur = p[3] as string;
      else e.curseurs.push({ instanceId: p[1] as string, declencheur: p[2] as string, valeur: p[3] as string });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`requête inconnue du faux moteur : ${sql.slice(0, 80)}`);
  }
}
