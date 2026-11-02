import type { Pool, PoolClient } from "pg";
import { avecClient, avecEquipe, type Appelant } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { Proposition } from "./nuit.js";

// Application d'une proposition de la nuit, sur un clic de l'équipe (C-365). C'est le seul fichier du dossier qui écrit hors de « à trancher ».
// Chaque action passe par le service du domaine (boîte d'envoi pour le Hub et le CRM, T2-14 et T2-15) : les exécuteurs sont fournis par l'appelant.
export interface LigneATrancher { id: string; tenantId: string; motif: string; etat: "ouvert" | "tranche"; proposition: Proposition }
export type Executeur = (client: PoolClient, ligne: LigneATrancher) => Promise<void>;
// État relu dans la transaction : valeur actuelle du maître (pour les clés de « apres ») et de la cible (pour les clés de « avant » et de « apres »).
export interface EtatCourant { maitre: Record<string, string | null>; cible: Record<string, string | null> }
export interface DepsAppliquer {
  charger(id: string): Promise<LigneATrancher | null>;
  transaction<T>(tenantId: string, appelant: Appelant, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  // Relit l'état réel dans la transaction, avec le client de la transaction (port : le Hub et le CRM viennent de T2-15 et T2-17).
  lireEtat(client: PoolClient, ligne: LigneATrancher): Promise<EtatCourant>;
  executeurs: Partial<Record<string, Executeur>>;
}

// Dette, propriétaire T2-14 (boîte d'envoi : les exécuteurs réels), un critère de test par action :
// - creer_fiche_hub : un essai d'intégration applique deux fois la même ligne et trouve une seule entrée en boîte d'envoi pour le Hub ; sans SIREN, aucune entrée.
// - creer_fiche_crm : même essai côté CRM ; la fiche créée porte le SIREN de la proposition et aucune donnée de la console en plus.
// - relier_fiche_gardee : un essai vérifie que seule la colonne crm_company_id de l'organisation du client change, et que la fiche visée existe et n'est pas absorbée.
// - demander_fusion_crm : aucun exécuteur de fusion sans fiche gardée choisie par l'équipe (refus testé ici tant que gardee est nul) ; un essai vérifie que l'exécuteur
//   envoie une demande de fusion au CRM et ne supprime ni ne fusionne aucune donnée de client dans la console, sans validation.
// - aligner_statut_hub : un essai vérifie que la demande part avec la valeur relue du maître (la console) et jamais avec une valeur de la proposition périmée.
// Tant que ces exécuteurs ne sont pas fournis, executeurs reste vide : tout se règle à la main.

// Fermeture atomique avec l'action : l'écriture passe par le rôle du client, le déclencheur d'audit trace l'acteur.
const FERMER = "UPDATE a_trancher SET etat = 'tranche', tranche_par = $2, decision = $3 WHERE id = $1 AND etat = 'ouvert' AND motif = 'incoherence_nuit'";
const TRANCHEE = "Cette ligne est déjà tranchée.";

async function fermer(client: PoolClient, id: string, acteur: string, decision: string): Promise<void> {
  const r = await client.query(FERMER, [id, acteur, decision]);
  // Zéro ligne : fermée entre-temps ; l'erreur annule la transaction, donc l'action n'est pas gardée.
  if (r.rowCount !== 1) throw new ErreurApi("regle_metier", TRANCHEE);
}

// Une proposition est une photo de la nuit : avant d'écrire, on vérifie qu'elle est encore vraie.
function verifierEtat(p: Proposition, etat: EtatCourant): void {
  const cles = Object.keys(p.apres);
  if (cles.some((k) => etat.maitre[k] !== p.apres[k])) throw new ErreurApi("regle_metier", "La valeur proposée a changé depuis la nuit : rien n'est appliqué.");
  if (cles.length > 0 && cles.every((k) => etat.cible[k] === p.apres[k])) throw new ErreurApi("regle_metier", "Cet écart est déjà réglé : rien n'est appliqué.");
  if (Object.keys(p.avant).some((k) => etat.cible[k] !== p.avant[k])) throw new ErreurApi("regle_metier", "La situation a changé depuis la nuit : rien n'est appliqué.");
}

// Fermeture de nuit des lignes périmées (decision « resolu:nuit »), propre au motif de la nuit. Jamais d'autre motif, jamais une ligne déjà tranchée.
const FERMER_PERIMEES = "UPDATE a_trancher SET etat = 'tranche', tranche_par = $1, decision = 'resolu:nuit' WHERE etat = 'ouvert' AND motif = 'incoherence_nuit' AND NOT (donnees_comparaison->>'cle' = ANY($2::text[]))";
export async function fermerPerimeesSql(client: PoolClient, acteur: string, clesProduites: string[]): Promise<number> {
  return (await client.query(FERMER_PERIMEES, [acteur, clesProduites])).rowCount ?? 0;
}

async function ouverte(d: DepsAppliquer, id: string): Promise<LigneATrancher> {
  const l = await d.charger(id);
  if (!l || l.motif !== "incoherence_nuit") throw new ErreurApi("introuvable", "Ressource introuvable.");
  if (l.etat !== "ouvert") throw new ErreurApi("regle_metier", TRANCHEE);
  return l;
}

export async function appliquerProposition(d: DepsAppliquer, id: string, appelant: Appelant, reauthentifie: boolean): Promise<void> {
  const ligne = await ouverte(d, id);
  const action = ligne.proposition.action;
  // Object.hasOwn : « toString » ou « constructor » ne sont pas des actions.
  const executeur = Object.hasOwn(d.executeurs, action) ? d.executeurs[action] : undefined;
  if (!executeur) throw new ErreurApi("regle_metier", "Cette proposition se règle à la main : écartez-la avec un motif.");
  // Une action qui écrit hors de la console demande une réauthentification récente (T1A-08).
  if (ligne.proposition.cible !== "console" && !reauthentifie) throw new ErreurApi("reauthentification_requise", "Réauthentification requise.");
  // Aucune fusion sans choix explicite : tant que la fiche gardée n'est pas choisie par l'équipe, rien ne part.
  if (action === "demander_fusion_crm" && !ligne.proposition.apres["gardee"]) throw new ErreurApi("regle_metier", "Choisissez d'abord la fiche gardée : aucune fusion sans ce choix.");
  await d.transaction(ligne.tenantId, appelant, async (client) => {
    verifierEtat(ligne.proposition, await d.lireEtat(client, ligne));
    await executeur(client, ligne);
    await fermer(client, ligne.id, appelant.acteur, `applique:${action}`);
  });
}

export async function ecarterProposition(d: DepsAppliquer, id: string, appelant: Appelant, motif: string): Promise<void> {
  const m = motif.trim();
  if (m === "" || m.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const ligne = await ouverte(d, id);
  await d.transaction(ligne.tenantId, appelant, (client) => fermer(client, ligne.id, appelant.acteur, `ecarte:${m}`));
}

// Branchement SQL : l'équipe retrouve la ligne (lecture seule), puis l'écriture se fait sous le rôle du client concerné.
export function depsSql(pool: Pool, poolEquipe: Pool, executeurs: DepsAppliquer["executeurs"], lireEtat: DepsAppliquer["lireEtat"]): DepsAppliquer {
  return {
    executeurs,
    lireEtat,
    transaction: (tenantId, appelant, fn) => avecClient(pool, tenantId, fn, appelant),
    async charger(id) {
      return avecEquipe(poolEquipe, async (c) => {
        const r = await c.query("SELECT tenant_id, id, motif, etat, donnees_comparaison->'proposition' AS proposition FROM a_trancher WHERE id = $1", [id]);
        const x = r.rows[0];
        return x ? { id: x.id, tenantId: x.tenant_id, motif: x.motif, etat: x.etat, proposition: x.proposition } : null;
      });
    },
  };
}
