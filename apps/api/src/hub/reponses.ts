import { z } from "zod";
import { CloreReponse, PlanReponse, RetrouverOuCreerReponse200, RetrouverOuCreerReponse202 } from "../../../../packages/contrats/src/c1/schemas.ts";
import type { LecteurTx } from "./client-c1.ts";

// Un gestionnaire par route, appelé par l'expéditeur avec la réponse du Hub. Aucune fiche n'est jamais écrite : une fiche absorbée
// ou un identifiant déjà pris part dans « à trancher » (C-338). Le motif et les métadonnées sont fermés : jamais le texte du Hub.
export interface ReponseHub { route: string; statut: number; corps: unknown; phaseId?: string; axiCli?: string; intention?: string }
export type Rangement = { rangee: "a_trancher" } | { axiCli: string } | { rangee: "plan" } | { rangee: "alerte" } | { rangee: "rien" };
// Alerte critique : codes fermés, identifiants seulement (jamais un texte du Hub).
export type AlerteHub = { niveau: "critique"; code: "plan_hub_deja_lie_autre"; phaseId: string; idPlan: string } | { niveau: "critique"; code: "clore_brouillons_non_emis"; idPlan: string; nombre: number };
export type Alerter = (a: AlerteHub) => Promise<void>;
const ErreurHub = z.object({ erreur: z.object({ code: z.string().regex(/^[a-z0-9_]{1,64}$/) }) });
const CODES_A_TRANCHER = ["fiche_absorbee", "identifiant_deja_pris"];

// Un rejeu de la même réponse ne range pas une seconde ligne, même après la décision de l'équipe : l'idDemande est unique par demande du Hub
// (ou, pour un 409/422, l'intention déposée), donc le test ne regarde pas l'état de la ligne.
// L'index unique partiel qui le garantirait en base est la dette LOT2-dette-T2-15-a-trancher-index (T2-52).
const aTrancher = (tx: LecteurTx, tenant: string, motif: string, idDemande: string, donnees: Record<string, string>) =>
  tx.query(
    "INSERT INTO a_trancher (tenant_id, id, organisation_id, source, motif, donnees_comparaison) SELECT $1::uuid, gen_random_uuid(), $1::uuid, 'hub', $2::motif_a_trancher, $3::jsonb " +
      "WHERE NOT EXISTS (SELECT 1 FROM a_trancher WHERE tenant_id = $1::uuid AND source = 'hub' AND donnees_comparaison->>'idDemande' = $4)",
    [tenant, motif, JSON.stringify({ ...donnees, idDemande }), idDemande],
  );

async function alerte(alerter: Alerter | undefined, a: AlerteHub, message: string): Promise<Rangement> {
  if (!alerter) throw new Error(message);
  await alerter(a);
  return { rangee: "alerte" };
}

export async function traiterReponse(tx: LecteurTx, tenant: string, r: ReponseHub, alerter?: Alerter): Promise<Rangement> {
  // 409 et 422 d'abord : un corps d'erreur n'est jamais lu comme une réponse 200 (C-338).
  const erreur = ErreurHub.safeParse(r.corps);
  const aTrancherErreur = (r.statut === 422 || r.statut === 409) && erreur.success && CODES_A_TRANCHER.includes(erreur.data.erreur.code) ? erreur.data.erreur.code : null;
  switch (r.route) {
    case "clients-retrouver-ou-creer": {
      if (aTrancherErreur) {
        if (!r.intention) throw new Error("intention de la ligne de boîte d'envoi absente : réponse d'erreur non rangée");
        await aTrancher(tx, tenant, "fiche_absorbee", r.intention, { code: aTrancherErreur });
        return { rangee: "a_trancher" };
      }
      if (r.statut === 202) {
        const lu = RetrouverOuCreerReponse202.parse(r.corps);
        await aTrancher(tx, tenant, "siren_absent_ressemblance", lu.idDemande, {});
        return { rangee: "a_trancher" };
      }
      return { axiCli: RetrouverOuCreerReponse200.parse(r.corps).axiCli };
    }
    case "clients-statut": {
      if (aTrancherErreur) {
        if (!r.axiCli) throw new Error("axiCli absent : réponse d'erreur du statut non rangée");
        if (!r.intention) throw new Error("intention de la ligne de boîte d'envoi absente : réponse d'erreur non rangée");
        await aTrancher(tx, tenant, "fiche_absorbee", r.intention, { code: aTrancherErreur, axiCli: r.axiCli });
        return { rangee: "a_trancher" };
      }
      return { rangee: "rien" };
    }
    case "plans-recurrents": {
      const { idPlan } = PlanReponse.parse(r.corps);
      if (!r.phaseId) throw new Error("phase du plan absente");
      // Jamais d'écrasement : un plan déjà lié reste lié.
      const fait = await tx.query("UPDATE phases_plan SET id_plan_hub = $1 WHERE tenant_id = $2 AND id = $3 AND id_plan_hub IS NULL RETURNING id", [idPlan, tenant, r.phaseId]);
      if (fait.rows.length > 0) return { rangee: "plan" };
      const lue = (await tx.query("SELECT id_plan_hub FROM phases_plan WHERE tenant_id = $1 AND id = $2", [tenant, r.phaseId])).rows[0];
      if (!lue) throw new Error("phase du plan inconnue");
      if (lue["id_plan_hub"] === idPlan) return { rangee: "plan" };
      // Un autre plan existe déjà au Hub pour cette phase : deux plans, donc de l'argent en double.
      return alerte(alerter, { niveau: "critique", code: "plan_hub_deja_lie_autre", phaseId: r.phaseId, idPlan }, "plan déjà lié à un autre plan du Hub : alerte critique requise");
    }
    case "plans-recurrents-clore": {
      const lu = CloreReponse.parse(r.corps);
      if (lu.brouillonsNonEmis.length === 0) return { rangee: "rien" };
      // La console ne supprime rien : elle garde les brouillons en alerte.
      return alerte(alerter, { niveau: "critique", code: "clore_brouillons_non_emis", idPlan: lu.idPlan, nombre: lu.brouillonsNonEmis.length }, "brouillons non émis à la clôture : alerte critique requise");
    }
    default:
      return { rangee: "rien" };
  }
}
