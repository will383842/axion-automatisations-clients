import type { Pool, PoolClient } from "pg";
import { avecEquipe, verifierAppelant } from "../db/client-actif.js";
import type { Role } from "../droits/matrice.js";
import type { DepotMembres, MembreEquipe } from "./membres.js";

// Dépôt SQL des membres (T3-07c) : rôle console_equipe SEUL. Aucun DELETE (non accordé), aucune réactivation (la règle de ligne l'interdit), aucune migration.
// L'acteur est posé dans app.acteur pour la durée de la transaction : le déclencheur membres_equipe_audit écrit le journal.
const DELAIS = "SELECT set_config('idle_in_transaction_session_timeout', '5s', true), set_config('lock_timeout', '5s', true)";
const LIMITE = 500;

async function enEcriture<T>(pool: Pool, acteur: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  verifierAppelant({ acteur });
  const c = await pool.connect();
  let detruire = false;
  try {
    await c.query("BEGIN");
    await c.query(DELAIS);
    await c.query("SELECT set_config('app.acteur', $1, true)", [acteur]);
    const r = await fn(c);
    await c.query("COMMIT").catch((e: unknown) => { detruire = true; throw e; });
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => { detruire = true; });
    throw e;
  } finally {
    c.release(detruire);
  }
}

export function creerDepotMembres(pool: Pool): DepotMembres {
  return {
    async lister() {
      return avecEquipe(pool, async (c) => {
        const r = await c.query("SELECT id, sujet, role, actif, portee_clients, cree_le, desactive_le FROM membres_equipe ORDER BY cree_le, id LIMIT $1", [LIMITE]);
        return r.rows.map((l): MembreEquipe => ({ id: l.id, sujet: l.sujet, role: l.role, actif: l.actif, porteeClients: l.portee_clients, creeLe: l.cree_le, desactiveLe: l.desactive_le }));
      });
    },
    async clientsExistent(ids) {
      return avecEquipe(pool, async (c) => (await c.query("SELECT count(DISTINCT tenant_id)::int AS n FROM organisations WHERE tenant_id = ANY($1::uuid[])", [ids])).rows[0]?.n === new Set(ids).size);
    },
    async inserer(m, acteur) {
      return enEcriture(pool, acteur, async (c) => ({
        id: (await c.query("INSERT INTO membres_equipe (sujet, role, portee_clients) VALUES ($1, $2, $3::uuid[]) RETURNING id", [m.sujet, m.role, m.porteeClients])).rows[0].id as string,
      }));
    },
    async desactiver(o, regle) {
      return enEcriture(pool, o.acteur.sujet, async (c) => {
        // Verrou de TOUS les dirigeants actifs (ordre fixe : pas d'interblocage), pris avant de compter : deux désactivations simultanées se suivent.
        const dirigeants = (await c.query("SELECT id FROM membres_equipe WHERE role = 'dirigeant' AND actif ORDER BY id FOR UPDATE")).rowCount ?? 0;
        const cible = (await c.query("SELECT sujet, role, actif FROM membres_equipe WHERE id = $1", [o.cibleId])).rows[0] as { sujet: string; role: Role; actif: boolean } | undefined;
        if (!cible) return { etat: "introuvable" } as const;
        if (!cible.actif) return { etat: "deja", sujet: cible.sujet } as const;
        if (!regle({ cible: { sujet: cible.sujet, role: cible.role }, dirigeantsActifs: dirigeants })) return { etat: "refuse" } as const;
        const maj = await c.query("UPDATE membres_equipe SET actif = false, desactive_le = now(), desactive_par = $2 WHERE id = $1 AND actif", [o.cibleId, o.acteur.sujet]);
        return maj.rowCount === 1 ? ({ etat: "desactive", sujet: cible.sujet } as const) : ({ etat: "deja", sujet: cible.sujet } as const);
      });
    },
  };
}
