import type { Pool, PoolClient } from "pg";
import { avecClient } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Annulation en un clic (A-030, C-443) : « annuler » est un nouveau changement (version et ligne de journal), jamais une suppression.
// La liste des entités annulables est FERMÉE : toute autre entité répond action_interdite. Chaque entité a son service du domaine,
// qui rejoue l'écriture inverse dans la transaction de l'appelant ; sans service branché, la fonction reste fermée (porte_fermee).
export const ENTITES_ANNULABLES = ["configurations", "plans_commerciaux", "conditions_commerciales"] as const;
export type EntiteAnnulable = (typeof ENTITES_ANNULABLES)[number];

export interface LigneAnnulation {
  id: string;
  tenant_id: string | null;
  entite: string;
  entite_id: string | null;
  action: string;
  ancienne: string | null; // JSON du journal, tel que lu (ancienne valeur)
  nouvelle: string | null;
}
export interface ServiceAnnulation {
  annuler(client: PoolClient, ligne: LigneAnnulation, auteur: string): Promise<{ entite: string; entite_id: string }>;
}
export type ServicesAnnulation = Partial<Record<EntiteAnnulable, ServiceAnnulation>>;

const estAnnulable = (e: string): e is EntiteAnnulable => (ENTITES_ANNULABLES as readonly string[]).includes(e);

export async function annuler(deps: { pool: Pool; services: ServicesAnnulation }, tenantId: string, auteur: string, idLigne: string): Promise<{ entite: string; entite_id: string }> {
  if (!/^[0-9]{1,18}$/.test(idLigne)) throw new ErreurApi("schema_invalide", "Identifiant de ligne invalide.");
  return avecClient(
    deps.pool,
    tenantId,
    async (client) => {
      // Le client actif filtre déjà (RLS) ; le filtre explicite garde l'isolation même si la politique changeait.
      const r = await client.query(
        "SELECT id::text AS id, tenant_id::text AS tenant_id, entite, entite_id, action::text AS action, ancienne::text AS ancienne, nouvelle::text AS nouvelle FROM public.journal_audit WHERE id = $1::bigint AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid",
        [idLigne],
      );
      const ligne = r.rows[0] as LigneAnnulation | undefined;
      if (!ligne) throw new ErreurApi("introuvable", "Ligne du journal introuvable.");
      if (!estAnnulable(ligne.entite)) throw new ErreurApi("action_interdite", "Ce changement ne s'annule pas.");
      const service = deps.services[ligne.entite];
      if (!service) throw new ErreurApi("porte_fermee", "Annulation indisponible pour ce changement.");
      return service.annuler(client, ligne, auteur);
    },
    { acteur: auteur },
  );
}
