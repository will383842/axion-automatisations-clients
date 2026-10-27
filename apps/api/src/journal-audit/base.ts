import type { Pool } from "pg";
import { avecClient } from "../db/client-actif.ts";
import type { EntreeAudit, JournalAudit } from "./port.ts";

// Journal d'audit en base (C5) : écrit par public.audit_ajouter, jamais par un INSERT (console_app n'en a pas le droit).
// Le motif et le montant vont dans `nouvelle` ; le motif ne doit porter aucune donnée de personne (règle de l'appelant, plafonds.ts).
// Avec un client : dans avecClient (la fonction exige que la ligne porte le client actif). Sans client (action de l'équipe) : transaction sans client actif.
const AJOUTER = "SELECT public.audit_ajouter($1::uuid, $2, $3::public.action_audit, $4, NULL, NULL, $5::jsonb)";

function entiteDe(entree: EntreeAudit): string {
  return entree.action === "levee_budget_jour" ? "budget_jour" : "cle_api";
}

export function creerJournalAuditBase(pool: Pool): JournalAudit {
  return {
    async ecrire(entree) {
      const montant = entree.montantConsommeMicroCentimes;
      if (montant !== undefined && !Number.isSafeInteger(montant)) throw new Error("montant du journal d'audit : un entier est attendu");
      const nouvelle = JSON.stringify({ motif: entree.motif, ...(montant === undefined ? {} : { montant_consomme_micro_centimes: montant }) });
      const valeurs = [entree.tenantId ?? null, entree.parQui, entree.action, entiteDe(entree), nouvelle];
      if (entree.tenantId !== undefined) {
        await avecClient(pool, entree.tenantId, (c) => c.query(AJOUTER, valeurs));
        return;
      }
      const client = await pool.connect();
      let detruire = false;
      try {
        await client.query("BEGIN");
        await client.query(AJOUTER, valeurs);
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
