import type { Pool } from "pg";
import { avecEquipe } from "../db/client-actif.ts";

// Accès en cours sur les données d'un client (B-026). Port + adaptateur des INTERVENTIONS (visibilite_acces, lecture seule par console_equipe).
// Les vues « comme le client » viennent de T3-08 (dette T3-07-dette-vues) ; aucune route « mettre fin » ici.
export interface AccesEnCoursItem { type: "vue_client" | "intervention"; clientId: string; debut: string; fin: string }
export interface AccesEnCours { lister(): Promise<AccesEnCoursItem[]> }

const LIRE = "SELECT tenant_id, intervention_debut, intervention_fin FROM visibilite_acces WHERE intervention_debut IS NOT NULL AND intervention_fin > now() ORDER BY intervention_fin LIMIT 500";

export function creerAccesInterventions(poolEquipe: Pool): AccesEnCours {
  return {
    async lister() {
      const { rows } = await avecEquipe(poolEquipe, (c) => c.query<{ tenant_id: string; intervention_debut: Date; intervention_fin: Date }>(LIRE));
      return rows.map((r) => ({ type: "intervention" as const, clientId: r.tenant_id, debut: new Date(r.intervention_debut).toISOString(), fin: new Date(r.intervention_fin).toISOString() }));
    },
  };
}
