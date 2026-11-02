import type pg from "pg";
import { avecClient, avecEquipe } from "../db/client-actif.js";
import type { DepotBalayage } from "./balayage-c2.js";
import type { EtatSujet, FaitRange } from "./recepteur-c2.js";

// Adaptateur Postgres du récepteur C2 (T2-16b) : faits_recus, cloisonnée par client (RLS forcée). `app` écrit et lit un client à la fois ;
// `equipe` (lecture seule) ne sert qu'à lister les sujets à balayer. Aucune suppression.
const MAX = Number.MAX_SAFE_INTEGER;
const sur = (valeur: unknown): number => {
  const n = Number(valeur);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX) throw new Error("entier hors bornes lu en base");
  return n;
};
const json = (valeur: unknown) => (valeur === null || valeur === undefined ? null : JSON.stringify(valeur));

export function depotPg(app: pg.Pool, equipe: pg.Pool): DepotBalayage {
  return {
    async organisationExiste(tenantId) {
      return (await avecClient(app, tenantId, (c) => c.query("SELECT 1 FROM organisations WHERE tenant_id = $1 LIMIT 1", [tenantId]))).rows.length > 0;
    },
    // Atomique : INSERT … ON CONFLICT DO NOTHING sur la clé (tenant_id, source, event_id). Le fait déjà là garde son contenu de la première réception.
    async ranger(tenantId, fait, recuLe) {
      return avecClient(app, tenantId, async (c) => {
        const ins = await c.query(
          `INSERT INTO faits_recus (tenant_id, id, source, event_id, type, sequence, sujet, recu_le, payload)
           VALUES ($1, gen_random_uuid(), 'hub', $2, $3, $4, $5, to_timestamp($6::double precision / 1000), $7::jsonb)
           ON CONFLICT (tenant_id, source, event_id) DO NOTHING RETURNING id`,
          [tenantId, fait.eventId, fait.type, fait.sequence, fait.sujet, recuLe, json(fait.payload)],
        );
        if (ins.rows.length > 0) return { neuf: true, traite: false, payload: fait.payload };
        const l = (await c.query("SELECT traite_le IS NOT NULL AS traite, payload FROM faits_recus WHERE tenant_id = $1 AND source = 'hub' AND event_id = $2", [tenantId, fait.eventId])).rows[0];
        return { neuf: false, traite: l?.["traite"] === true, payload: l?.["payload"] ?? null };
      });
    },
    async etatSujet(tenantId, sujet): Promise<EtatSujet> {
      return avecClient(app, tenantId, async (c) => {
        const derniere = (await c.query("SELECT max(sequence)::text AS s FROM faits_recus WHERE tenant_id = $1 AND source = 'hub' AND sujet = $2 AND traite_le IS NOT NULL", [tenantId, sujet])).rows[0]?.["s"];
        const attente = await c.query(
          "SELECT sequence::text AS s, (extract(epoch FROM recu_le) * 1000)::bigint::text AS r FROM faits_recus WHERE tenant_id = $1 AND source = 'hub' AND sujet = $2 AND traite_le IS NULL ORDER BY sequence LIMIT 1000",
          [tenantId, sujet],
        );
        return { derniereTraitee: derniere === null || derniere === undefined ? null : sur(derniere), enAttente: attente.rows.map((r) => ({ sequence: sur(r["s"]), recuLe: sur(r["r"]) })) };
      });
    },
    async sujetsEnAttente(limite) {
      if (!Number.isSafeInteger(limite) || limite < 1) throw new Error("limite invalide");
      const rows = (
        await avecEquipe(equipe, (c) =>
          c.query("SELECT tenant_id, sujet FROM faits_recus WHERE source = 'hub' AND traite_le IS NULL GROUP BY tenant_id, sujet ORDER BY min(recu_le), tenant_id, sujet LIMIT $1", [limite]),
        )
      ).rows;
      return rows.map((r) => ({ tenantId: r["tenant_id"] as string, sujet: r["sujet"] as string }));
    },
    async faitAttendu(tenantId, sujet, sequence): Promise<FaitRange | undefined> {
      const l = (
        await avecClient(app, tenantId, (c) =>
          c.query("SELECT event_id, type, sequence::text AS sequence, sujet, payload FROM faits_recus WHERE tenant_id = $1 AND source = 'hub' AND sujet = $2 AND sequence = $3 AND traite_le IS NULL ORDER BY recu_le, event_id LIMIT 1", [tenantId, sujet, sequence]),
        )
      ).rows[0];
      return l ? { eventId: l["event_id"], type: l["type"], sequence: sur(l["sequence"]), sujet: l["sujet"], payload: l["payload"] ?? null } : undefined;
    },
  };
}
