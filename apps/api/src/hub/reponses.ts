import { z } from "zod";
import { PlanReponse, RetrouverOuCreerReponse200, RetrouverOuCreerReponse202 } from "../../../../packages/contrats/src/c1/schemas.ts";
import type { LecteurTx } from "./client-c1.ts";

// Un gestionnaire par route, appelé par l'expéditeur avec la réponse du Hub. Aucune fiche n'est jamais écrite : une fiche absorbée
// ou un identifiant déjà pris part dans « à trancher » (C-338). Le motif et les métadonnées sont fermés : jamais le texte du Hub.
export interface ReponseHub { route: string; statut: number; corps: unknown; phaseId?: string }
export type Rangement = { rangee: "a_trancher" } | { axiCli: string } | { rangee: "plan" } | { rangee: "rien" };
const ErreurHub = z.object({ erreur: z.object({ code: z.string().regex(/^[a-z0-9_]{1,64}$/) }) });
const aTrancher = (tx: LecteurTx, tenant: string, motif: string, donnees: Record<string, string>) =>
  tx.query("INSERT INTO a_trancher (tenant_id, id, organisation_id, source, motif, donnees_comparaison) VALUES ($1, gen_random_uuid(), $1, 'hub', $2::motif_a_trancher, $3::jsonb)", [tenant, motif, JSON.stringify(donnees)]);

export async function traiterReponse(tx: LecteurTx, tenant: string, r: ReponseHub): Promise<Rangement> {
  switch (r.route) {
    case "clients-retrouver-ou-creer": {
      if (r.statut === 202) {
        const lu = RetrouverOuCreerReponse202.parse(r.corps);
        await aTrancher(tx, tenant, "siren_absent_ressemblance", { idDemande: lu.idDemande });
        return { rangee: "a_trancher" };
      }
      return { axiCli: RetrouverOuCreerReponse200.parse(r.corps).axiCli };
    }
    case "clients-statut": {
      const code = ErreurHub.safeParse(r.corps);
      if ((r.statut === 422 || r.statut === 409) && code.success && ["fiche_absorbee", "identifiant_deja_pris"].includes(code.data.erreur.code)) {
        await aTrancher(tx, tenant, "fiche_absorbee", { code: code.data.erreur.code });
        return { rangee: "a_trancher" };
      }
      return { rangee: "rien" };
    }
    case "plans-recurrents": {
      const { idPlan } = PlanReponse.parse(r.corps);
      if (!r.phaseId) throw new Error("phase du plan absente");
      // Jamais d'écrasement : un plan déjà lié reste lié.
      await tx.query("UPDATE phases_plan SET id_plan_hub = $1 WHERE tenant_id = $2 AND id = $3 AND id_plan_hub IS NULL", [idPlan, tenant, r.phaseId]);
      return { rangee: "plan" };
    }
    default:
      return { rangee: "rien" };
  }
}
