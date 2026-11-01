import type { Pool } from "pg";
import { avecClient } from "../../db/connexion.ts";
import type { Bail, BoiteEnvoi, Intention } from "../ports.ts";

type Etat = Intention["etat"];

// Boîte d'envoi sur la table intentions, pour un seul client. La clé est unique PAR client : c'est l'anti-doublon de dernier recours.
// Chaque méthode est une transaction terminée à son retour : l'intention est donc validée en base AVANT l'appel du connecteur (A-316).
// Aucune migration (ADR 0102) : la table ne garde ni bail ni détail de l'appel. Le bail ne vaut que dans ce processus ; entre deux processus,
// la garantie du connecteur tranche (même clé, vérification après coup, ou « à trancher ») : jamais de renvoi à l'aveugle.
export class BoitePostgres implements BoiteEnvoi {
  #baux = new Map<string, Bail>();
  #connues = new Map<string, Omit<Intention, "etat" | "bail">>();

  constructor(
    private pool: Pool,
    private tenantId: string,
  ) {}

  async ecrire(i: Omit<Intention, "etat" | "bail">, bail: Bail, maintenant: number) {
    const lue = await avecClient(this.pool, this.tenantId, async (c) => {
      const exec = await c.query<{ debut: Date }>("SELECT debut FROM executions WHERE tenant_id = $1 AND id = $2 AND instance_id = $3", [this.tenantId, i.executionId, i.instanceId]);
      if (!exec.rows[0]) throw new Error("execution_inconnue");
      const ajout = await c.query(
        "INSERT INTO intentions (tenant_id, id, execution_id, debut_execution, cle_intention, garantie) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5) ON CONFLICT (tenant_id, cle_intention) DO NOTHING",
        [this.tenantId, i.executionId, exec.rows[0].debut, i.cle, i.garantie],
      );
      const x = await c.query<{ etat: Etat; garantie: Intention["garantie"] }>("SELECT etat, garantie FROM intentions WHERE tenant_id = $1 AND cle_intention = $2", [this.tenantId, i.cle]);
      return { creee: ajout.rowCount === 1, etat: x.rows[0]!.etat, garantie: x.rows[0]!.garantie };
    });
    this.#connues.set(i.cle, i);
    const actuel = this.#baux.get(i.cle);
    const occupee = lue.etat === "ecrite" && actuel !== undefined && actuel.proprietaire !== bail.proprietaire && actuel.jusqua > maintenant;
    if (lue.etat === "ecrite" && !occupee) this.#baux.set(i.cle, bail);
    return { intention: { ...i, garantie: lue.garantie, etat: lue.etat, ...(this.#baux.has(i.cle) ? { bail: this.#baux.get(i.cle)! } : {}) } as Intention, creee: lue.creee, occupee };
  }

  async lire(cle: string) {
    const { rows } = await avecClient(this.pool, this.tenantId, (c) =>
      c.query<{ etat: Etat; garantie: Intention["garantie"]; execution_id: string }>("SELECT etat, garantie FROM intentions WHERE tenant_id = $1 AND cle_intention = $2", [this.tenantId, cle]),
    );
    const r = rows[0];
    if (!r) return undefined;
    const connue = this.#connues.get(cle);
    // Les détails de l'appel ne sont pas en base : vides pour une intention écrite par un autre processus.
    return { cle, instanceId: connue?.instanceId ?? "", executionId: r.execution_id, etape: connue?.etape ?? "", element: connue?.element ?? "", action: connue?.action ?? "", garantie: r.garantie, etat: r.etat } satisfies Intention;
  }

  marquerFaite(cle: string, proprietaire: string) {
    return this.#changer(cle, proprietaire, "faite");
  }
  marquerATrancher(cle: string, proprietaire: string) {
    return this.#changer(cle, proprietaire, "a_trancher");
  }
  async liberer(cle: string, proprietaire: string) {
    if (this.#baux.get(cle)?.proprietaire === proprietaire) this.#baux.delete(cle);
  }

  async #changer(cle: string, proprietaire: string, etat: "faite" | "a_trancher") {
    if (this.#baux.get(cle)?.proprietaire !== proprietaire) return false;
    // Comparer-et-échanger en base : seulement depuis « ecrite ».
    const r = await avecClient(this.pool, this.tenantId, (c) => c.query("UPDATE intentions SET etat = $3 WHERE tenant_id = $1 AND cle_intention = $2 AND etat = 'ecrite'", [this.tenantId, cle, etat]));
    return r.rowCount === 1;
  }
}

