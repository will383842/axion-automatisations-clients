import { ROUTES_C1 } from "../../../../packages/contrats/src/c1/routes.ts";
import { DevisRequete, PlanRequete, CloreRequete, RetrouverOuCreerRequete, StatutRequete, MotifCloture } from "../../../../packages/contrats/src/c1/schemas.ts";
import { TVA_AUTOMATISATION_BPS } from "../../../../packages/contrats/src/commun/argent.ts";
import { statutVersHub } from "../clients/statut.ts";
import type { StatutConsole } from "../crm/statuts.ts";
import { createHash } from "node:crypto";
import type { z } from "zod";

// Client C1 vers le Hub (C-324, C-338, C-361, C-363, C-455, C-456, C-550). Chaque fonction dépose dans la boîte d'envoi, dans la transaction
// du changement métier (`deposer` est lié à cette transaction, T2-14), avec une intention STABLE : ni horodatage ni UUID aléatoire.
export interface DepotHub { destination: "hub"; route: string; methode: "POST"; corps: unknown; intention: string }
export type LecteurTx = { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
export interface DepsClientC1 {
  deposer: (d: DepotHub) => Promise<{ nouveau: boolean }>;
  tx: LecteurTx;
  // Drapeau lu dans la réponse du Hub : fermé par défaut. Tant qu'il est faux, aucun POST /devis ne part (dette LOT2-dette-T2-15-devis-reel).
  gardesSignatureHub?: boolean;
}
const RACINE = "/api/console/v1";
const route = (nom: keyof typeof ROUTES_C1, p: Record<string, string> = {}) => RACINE + ROUTES_C1[nom].chemin.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(p[k] ?? ""));
// Forme d'un axiCli : refusée avant la boîte d'envoi, car il entre dans le chemin de la route.
const AXI_CLI = /^AXI-CLI-[0-9]{6}$/;
const exigerAxiCli = (v: string): void => { if (!AXI_CLI.test(v)) throw new Error("axiCli mal formé : refusé avant la boîte d'envoi"); };
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
    // `decisionId` : décision a_trancher tranchée, jamais envoyée au Hub ; elle ouvre une nouvelle recherche (C-456).
    async retrouverOuCreer(o: z.input<typeof RetrouverOuCreerRequete> & { decisionId?: string }) {
      const t = await client(o.consoleClientId);
      const { decisionId, ...corps } = o;
      // Le SIREN part toujours quand il est connu : le Hub cherche avant de créer.
      const lu = RetrouverOuCreerRequete.parse(corps);
      // Une recherche par état d'identité : l'empreinte couvre SIREN, raison sociale et décision tranchée.
      const empreinte = createHash("sha256").update(JSON.stringify([lu.siren ?? "", lu.raisonSociale, decisionId ?? ""])).digest("hex").slice(0, 32);
      return envoyer("clients-retrouver-ou-creer", {}, lu, `retrouver:${t}:${empreinte}`);
    },
    // `repere` : repère stable de la transition (id de la ligne d'historique), jamais un horodatage.
    async changerStatut(p: { axiCli: string; consoleClientId: string; statut: StatutConsole; repere: string }) {
      exigerAxiCli(p.axiCli);
      const t = await client(p.consoleClientId);
      await sansDecisionOuverte(t);
      const statut = statutVersHub(p.statut);
      return envoyer("clients-statut", { axiCli: p.axiCli }, StatutRequete.parse({ statut, consoleClientId: t }), `statut:${t}:${p.axiCli}:${statut}:${p.repere}`);
    },
    async devis(p: { axiCli: string; consoleClientId: string; referencePropositionConsole: string; revision?: number; lignes: Ligne[] }) {
      exigerAxiCli(p.axiCli);
      const t = await client(p.consoleClientId);
      await sansDecisionOuverte(t);
      if (d.gardesSignatureHub !== true) throw new Error("devis non envoyé : le Hub ne déclare pas les gardes de signature (dette LOT2-dette-T2-15-devis-reel)");
      const email = (await d.tx.query("SELECT email FROM contacts WHERE tenant_id = $1 AND organisation_id = $1 AND role = 'facturation' AND length(btrim(email)) > 0 LIMIT 1", [t])).rows[0]?.["email"];
      if (typeof email !== "string") throw new Error("ajoutez l'e-mail du contact avant de créer le devis");
      // Activité et TVA imposées ici, jamais lues de l'appelant ; les centimes sont validés entiers et bornés par le schéma.
      const lignes = p.lignes.map((l) => ({ libelle: l.libelle, quantite: l.quantite, prixUnitaireHtCentimes: l.prixUnitaireHtCentimes, activite: "automatisation" as const, tauxTvaBps: TVA_AUTOMATISATION_BPS }));
      const corps = DevisRequete.parse({ axiCli: p.axiCli, referencePropositionConsole: p.referencePropositionConsole, lignes });
      // Le numéro de révision ne fait que distinguer l'intention ; le corps n'en porte pas (dette LOT2-dette-T2-15-devis-reel).
      return envoyer("devis", {}, corps, `devis:${p.referencePropositionConsole}:r${p.revision ?? 1}`);
    },
    async plan(p: { axiCli: string; consoleClientId: string; codeAutomatisation: string; referenceAbonnementConsole: string; referenceContratConsole: string; phaseId: string; montantHtCentimesParPeriode: number; periodeMois: 1 | 6 | 12; premiereEcheance: string; engagementMois: number }) {
      exigerAxiCli(p.axiCli);
      const t = await client(p.consoleClientId);
      await sansDecisionOuverte(t);
      // UNE intention par phase du plan : deux mois ne font jamais deux plans au Hub.
      const { phaseId, ...reste } = p;
      delete (reste as { consoleClientId?: string }).consoleClientId;
      return envoyer("plans-recurrents", {}, PlanRequete.parse(reste), `plan:${phaseId}`);
    },
    // Clore signale les brouillons non émis sans rien supprimer : la console les garde en alerte.
    async clore(p: { idPlan: string; dateFin: string; motif: z.infer<typeof MotifCloture> }) {
      return envoyer("plans-recurrents-clore", { idPlan: p.idPlan }, CloreRequete.parse({ dateFin: p.dateFin, motif: p.motif }), `clore:${p.idPlan}`);
    },
  };
}
