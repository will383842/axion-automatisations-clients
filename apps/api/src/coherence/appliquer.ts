import type { Pool, PoolClient } from "pg";
import { avecClient, avecEquipe, type Appelant } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { Proposition } from "./nuit.js";

// Application d'une proposition de la nuit, sur un clic de l'équipe (C-365). C'est le seul fichier du dossier qui écrit hors de « à trancher ».
// Chaque action passe par le service du domaine (boîte d'envoi pour le Hub et le CRM, T2-14 et T2-15) : les exécuteurs sont fournis par l'appelant.
export interface LigneATrancher { id: string; tenantId: string; motif: string; etat: "ouvert" | "tranche"; proposition: Proposition }
export type Executeur = (client: PoolClient, ligne: LigneATrancher) => Promise<void>;
export interface DepsAppliquer {
  charger(id: string): Promise<LigneATrancher | null>;
  transaction<T>(tenantId: string, appelant: Appelant, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  executeurs: Partial<Record<string, Executeur>>;
}

// Fermeture atomique avec l'action : l'écriture passe par le rôle du client, le déclencheur d'audit trace l'acteur.
const FERMER = "UPDATE a_trancher SET etat = 'tranche', tranche_par = $2, decision = $3 WHERE id = $1 AND etat = 'ouvert' AND motif = 'incoherence_nuit'";
const TRANCHEE = "Cette ligne est déjà tranchée.";

async function fermer(client: PoolClient, id: string, acteur: string, decision: string): Promise<void> {
  const r = await client.query(FERMER, [id, acteur, decision]);
  // Zéro ligne : fermée entre-temps ; l'erreur annule la transaction, donc l'action n'est pas gardée.
  if (r.rowCount !== 1) throw new ErreurApi("regle_metier", TRANCHEE);
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
  const executeur = d.executeurs[action];
  if (!executeur) throw new ErreurApi("regle_metier", "Cette proposition se règle à la main : écartez-la avec un motif.");
  // Une action qui écrit hors de la console demande une réauthentification récente (T1A-08).
  if (ligne.proposition.cible !== "console" && !reauthentifie) throw new ErreurApi("reauthentification_requise", "Réauthentification requise.");
  await d.transaction(ligne.tenantId, appelant, async (client) => {
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
export function depsSql(pool: Pool, poolEquipe: Pool, executeurs: DepsAppliquer["executeurs"]): DepsAppliquer {
  return {
    executeurs,
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
