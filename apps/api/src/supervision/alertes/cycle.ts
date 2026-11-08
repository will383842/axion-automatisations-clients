import type { Pool } from "pg";
import { avecClient } from "../../db/client-actif.js";
import { cleRegroupement, type CauseAlerte } from "./regrouper.js";
import type { Notifications } from "./ouvrir.js";

// Cycle de vie d'une alerte (T5-04b, ADR 0126) : attribuer, commenter, clore, rétablir. Toujours sous le verrou de l'alerte (FOR UPDATE).
// Clore passe par une clôture motivée (raison = code) : la base refuse « close » sans elle (politique cloture_motivee).
export const RAISONS_CLOTURE = ["traitee", "fausse_alerte", "doublon", "sans_suite", "retabli"] as const;
export const COMMENTAIRE_MAX = 500;

export class ErreurCycle extends Error {
  constructor(readonly code: "raison_invalide" | "commentaire_invalide" | "alerte_close") {
    super(code);
    this.name = "ErreurCycle";
  }
}

export interface DepotCycle {
  retablir(tenantId: string, cle: string): Promise<{ alerteId: string } | null>;
  attribuer(tenantId: string, alerteId: string, acteur: string): Promise<boolean>;
  commenter(tenantId: string, alerteId: string, texte: string, acteur: string): Promise<void>;
  clore(tenantId: string, alerteId: string, raison: string, acteur: string): Promise<boolean>;
}

// Retour au vert : au plus UNE notification, envoyée après la validation de la transaction ; un rejeu ne trouve plus d'alerte en cours et n'envoie rien.
export async function retablirAlerte(depot: DepotCycle, notifications: Notifications, tenantId: string, cause: CauseAlerte): Promise<void> {
  const r = await depot.retablir(tenantId, cleRegroupement(cause));
  if (r) await notifications.retabli(tenantId, r.alerteId);
}

export async function attribuer(depot: DepotCycle, tenantId: string, alerteId: string, acteur: string): Promise<void> {
  if (!(await depot.attribuer(tenantId, alerteId, acteur))) throw new ErreurCycle("alerte_close");
}

export async function commenter(depot: DepotCycle, tenantId: string, alerteId: string, texte: string, acteur: string): Promise<void> {
  const t = typeof texte === "string" ? texte.trim() : "";
  if (t.length < 1 || t.length > COMMENTAIRE_MAX) throw new ErreurCycle("commentaire_invalide"); // refusé, jamais tronqué
  await depot.commenter(tenantId, alerteId, t, acteur);
}

export async function clore(depot: DepotCycle, tenantId: string, alerteId: string, raison: string, acteur: string): Promise<void> {
  if (!(RAISONS_CLOTURE as readonly string[]).includes(raison)) throw new ErreurCycle("raison_invalide");
  if (!(await depot.clore(tenantId, alerteId, raison, acteur))) throw new ErreurCycle("alerte_close");
}

const EN_COURS = "etat IN ('ouverte','acquittee')";
export function depotSqlCycle(pool: Pool): DepotCycle {
  // Clôture sous verrou : la ligne de clôture d'abord (la base l'exige), puis l'état. Rend false si l'alerte n'est plus en cours (rien n'est écrit).
  const cloreSous = async (c: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, tenantId: string, id: string, raison: string, acteur: string): Promise<boolean> => {
    if (!(await c.query(`SELECT id FROM alertes WHERE tenant_id = $1 AND id = $2 AND ${EN_COURS} FOR UPDATE`, [tenantId, id])).rows[0]) return false;
    await c.query("INSERT INTO clotures_alertes (tenant_id, alerte_id, raison, auteur) VALUES ($1, $2, $3, $4)", [tenantId, id, raison, acteur]);
    await c.query("UPDATE alertes SET etat = 'close' WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return true;
  };
  return {
    async retablir(tenantId, cle) {
      return avecClient(
        pool,
        tenantId,
        async (c) => {
          const a = (await c.query(`SELECT id FROM alertes WHERE tenant_id = $1 AND cle_regroupement = $2 AND ${EN_COURS} FOR UPDATE`, [tenantId, cle])).rows[0] as { id: string } | undefined;
          if (!a) return null;
          await c.query("INSERT INTO clotures_alertes (tenant_id, alerte_id, raison, auteur) VALUES ($1, $2, 'retabli', 'supervision')", [tenantId, a.id]);
          await c.query("UPDATE alertes SET etat = 'close' WHERE tenant_id = $1 AND id = $2", [tenantId, a.id]);
          return { alerteId: a.id };
        },
        { acteur: "supervision" },
      );
    },
    attribuer: (tenantId, id, acteur) =>
      avecClient(pool, tenantId, async (c) => ((await c.query(`UPDATE alertes SET etat = 'acquittee', assignee_a = $3 WHERE tenant_id = $1 AND id = $2 AND ${EN_COURS}`, [tenantId, id, acteur])).rowCount ?? 0) > 0, { acteur }),
    commenter: (tenantId, id, texte, acteur) =>
      avecClient(pool, tenantId, async (c) => void (await c.query("INSERT INTO commentaires_alertes (tenant_id, id, alerte_id, auteur, texte) VALUES ($1, gen_random_uuid(), $2, $3, $4)", [tenantId, id, acteur, texte])), { acteur }),
    clore: (tenantId, id, raison, acteur) => avecClient(pool, tenantId, (c) => cloreSous(c, tenantId, id, raison, acteur), { acteur }),
  };
}
