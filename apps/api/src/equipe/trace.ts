import type { Pool } from "pg";
import { verifierAppelant } from "../db/client-actif.ts";

// Trace de la révocation d'une session de l'équipe (T3-07b) : action de l'équipe, donc sans client actif (tenant NULL), par public.audit_ajouter
// (seule porte d'écriture ouverte à console_app). Aucune valeur d'énumération ajoutée. `nouvelle` = { geste, membre_id } : jamais d'e-mail, de nom ni d'adresse IP.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AJOUTER = "SELECT public.audit_ajouter($1::uuid, $2, $3::public.action_audit, $4, $5, NULL, $6::jsonb)";

export interface EntreeRevocation { acteur: string; membreId: string; sessionId: string }
export interface TraceSessions { revocation(e: EntreeRevocation): Promise<void> }

export function creerTraceSessions(pool: Pool): TraceSessions {
  return {
    async revocation(e) {
      verifierAppelant({ acteur: e.acteur });
      if (!UUID.test(e.membreId) || !UUID.test(e.sessionId)) throw new Error("trace de révocation : identifiant invalide");
      const client = await pool.connect();
      let detruire = false;
      try {
        await client.query("BEGIN");
        await client.query(AJOUTER, [null, e.acteur, "modification", "session_equipe", e.sessionId, JSON.stringify({ geste: "revocation", membre_id: e.membreId })]);
        await client.query("COMMIT");
      } catch (erreur) {
        await client.query("ROLLBACK").catch(() => (detruire = true));
        throw erreur;
      } finally {
        client.release(detruire || undefined);
      }
    },
  };
}
