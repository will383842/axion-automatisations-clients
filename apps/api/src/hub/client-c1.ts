import { ROUTES_C1 } from "../../../../packages/contrats/src/c1/routes.ts";
import { DevisRequete, PlanRequete, CloreRequete, RetrouverOuCreerRequete, StatutRequete, MotifCloture } from "../../../../packages/contrats/src/c1/schemas.ts";
import { TVA_AUTOMATISATION_BPS } from "../../../../packages/contrats/src/commun/argent.ts";
import { statutVersHub } from "../clients/statut.ts";
import type { StatutConsole } from "../crm/statuts.ts";
import type { z } from "zod";

// Client C1 vers le Hub (C-324, C-338, C-361, C-363, C-455, C-456, C-550). Chaque fonction dépose dans la boîte d'envoi, dans la transaction
// du changement métier (`deposer` est lié à cette transaction, T2-14), avec une intention STABLE : ni horodatage ni UUID aléatoire.
export interface DepotHub { destination: "hub"; route: string; methode: "POST"; corps: unknown; intention: string }
export type LecteurTx = { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
export interface DepsClientC1 {
  deposer: (d: DepotHub) => Promise<{ nouveau: boolean }>;
  tx: LecteurTx;
  // Drapeau lu dans la réponse du Hub : fermé par défaut. Tant qu'il est faux, aucun POST /devis ne part (T2BIS-01).
  gardesSignatureHub?: boolean;
}
const RACINE = "/api/console/v1";
const route = (nom: keyof typeof ROUTES_C1, p: Record<string, string> = {}) => RACINE + ROUTES_C1[nom].chemin.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(p[k] ?? ""));
type Ligne = { libelle: string; quantite: number; prixUnitaireHtCentimes: number };

export function clientC1(d: DepsClientC1) {
  // Le client est celui de la TRANSACTION ; l'identifiant console (= tenant) doit lui être égal.
  async function client(consoleClientId: string): Promise<string> {
    const t = (await d.tx.query("SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant")).rows[0]?.["tenant"];
    if (typeof t !== "string" || t !== consoleClientId) throw new Error("client de la transaction différent de celui de la demande");
    return t;
  }
  // Tant que l'équipe n'a pas tranché, rien d'autre que la recherche ne part pour ce client (C-456).
  async function sansDecisionOuverte(t: string): Promise<void> {
    if ((await d.tx.query("SELECT 1 AS un FROM a_trancher WHERE tenant_id = $1 AND organisation_id = $1 AND etat = 'ouvert' LIMIT 1", [t])).rows.length > 0) throw new Error("client à trancher : décision de l'équipe attendue avant tout envoi");
  }
  const envoyer = (nom: keyof typeof ROUTES_C1, p: Record<string, string>, corps: unknown, intention: string) =>
    d.deposer({ destination: "hub", route: route(nom, p), methode: "POST", corps, intention });

  return {
    async retrouverOuCreer(o: z.input<typeof RetrouverOuCreerRequete>) {
      const t = await client(o.consoleClientId);
      // Le SIREN part toujours quand il est connu : le Hub cherche avant de créer.
      return envoyer("clients-retrouver-ou-creer", {}, RetrouverOuCreerRequete.parse(o), `retrouver:${t}`);
    },
    async changerStatut(p: { axiCli: string; consoleClientId: string; statut: StatutConsole }) {
      const t = await client(p.consoleClientId);
      await sansDecisionOuverte(t);
      const statut = statutVersHub(p.statut);
      return envoyer("clients-statut", { axiCli: p.axiCli }, StatutRequete.parse({ statut, consoleClientId: t }), `statut:${t}:${statut}`);
    },
    async devis(p: { axiCli: string; consoleClientId: string; referencePropositionConsole: string; revision?: number; lignes: Ligne[] }) {
      const t = await client(p.consoleClientId);
      await sansDecisionOuverte(t);
      if (d.gardesSignatureHub !== true) throw new Error("devis non envoyé : le Hub ne déclare pas les gardes de signature (T2BIS-01)");
      const email = (await d.tx.query("SELECT email FROM contacts WHERE tenant_id = $1 AND organisation_id = $1 AND role = 'facturation' AND length(btrim(email)) > 0 LIMIT 1", [t])).rows[0]?.["email"];
      if (typeof email !== "string") throw new Error("ajoutez l'e-mail du contact avant de créer le devis");
      // Activité et TVA imposées ici, jamais lues de l'appelant ; les centimes sont validés entiers et bornés par le schéma.
      const lignes = p.lignes.map((l) => ({ libelle: l.libelle, quantite: l.quantite, prixUnitaireHtCentimes: l.prixUnitaireHtCentimes, activite: "automatisation" as const, tauxTvaBps: TVA_AUTOMATISATION_BPS }));
      const corps = DevisRequete.parse({ axiCli: p.axiCli, referencePropositionConsole: p.referencePropositionConsole, lignes });
      // Une vente déjà acceptée ou annulée repart comme RÉVISION de la même référence, jamais comme second devis.
      return envoyer("devis", {}, corps, `devis:${p.referencePropositionConsole}:r${p.revision ?? 1}`);
    },
    async plan(p: { axiCli: string; consoleClientId: string; codeAutomatisation: string; referenceAbonnementConsole: string; referenceContratConsole: string; debutPeriode: string; montantHtCentimesParPeriode: number; periodeMois: 1 | 6 | 12; premiereEcheance: string; engagementMois: number }) {
      const t = await client(p.consoleClientId);
      await sansDecisionOuverte(t);
      const { debutPeriode, ...reste } = p;
      delete (reste as { consoleClientId?: string }).consoleClientId;
      return envoyer("plans-recurrents", {}, PlanRequete.parse(reste), `plan:${p.referenceContratConsole}:${debutPeriode}`);
    },
    // Clore signale les brouillons non émis sans rien supprimer : la console les garde en alerte.
    async clore(p: { idPlan: string; dateFin: string; motif: z.infer<typeof MotifCloture> }) {
      return envoyer("plans-recurrents-clore", { idPlan: p.idPlan }, CloreRequete.parse({ dateFin: p.dateFin, motif: p.motif }), `clore:${p.idPlan}`);
    },
  };
}
