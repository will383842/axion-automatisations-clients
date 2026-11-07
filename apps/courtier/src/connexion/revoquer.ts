import { cheminJetons } from "./imap.js";

// Révocation d'une connexion (T4-42b, A-393) : seulement sur geste d'une personne autorisée (la route), jamais par une échéance.
// Ordre : base (définitive, avec l'auteur), pause des instances liées, révocation chez le fournisseur quand elle existe, effacement de la VALEUR au coffre, trace.
// Les ports sont la seule voie d'accès : aucune donnée de travail du client n'est lue ni écrite ici. Les ports réels sont câblés plus tard (dette D1, D2).
export type Fournisseur = "microsoft" | "google" | "imap";
export interface PortsRevocation {
  existe(tenantId: string, connexionId: string): Promise<boolean>;
  fournisseurDe(tenantId: string, connexionId: string): Promise<Fournisseur>;
  // Vrai pour la seule révocation effective (la base ne modifie plus une ligne révoquée) ; l'auteur part dans le journal d'audit de la base.
  marquerRevoquee(tenantId: string, connexionId: string, acteur: string, motif: string): Promise<boolean>;
  mettreEnPause(tenantId: string, connexionId: string, acteur: string): Promise<number>;
  lireJeton(chemin: string): Promise<string | undefined>;
  // Détruit toutes les versions des valeurs ; la référence en base et la pièce « compte » restent.
  effacerValeur(chemins: string[]): Promise<void>;
  alerter(code: string, contexte: { tenantId: string; connexionId: string }): void;
  fetch: typeof fetch;
  journal: { tracer(evenement: Record<string, string>): void };
}
export interface DemandeRevocation { tenantId: string; connexionId: string; acteur: string; motif: string }
export type ResultatRevocation =
  | { etat: "revoquee"; effacement: "fait" | "a_refaire" }
  | { etat: "deja_revoquee" | "inconnue" | "refusee" };

const MOTIFS = ["demande_client", "decision_dirigeant"];
const REVOCATION_GOOGLE = "https://oauth2.googleapis.com/revoke";

export async function revoquerConnexion(p: PortsRevocation, d: DemandeRevocation): Promise<ResultatRevocation> {
  const acteur = typeof d.acteur === "string" ? d.acteur.trim() : "";
  if (!MOTIFS.includes(d.motif) || acteur === "" || acteur.toLowerCase() === "systeme") return { etat: "refusee" };
  if (!(await p.existe(d.tenantId, d.connexionId))) return { etat: "inconnue" };
  // 1. La base d'abord : définitive. Zéro ligne : déjà révoquée, rien d'autre ne se passe.
  if (!(await p.marquerRevoquee(d.tenantId, d.connexionId, acteur, d.motif))) return { etat: "deja_revoquee" };
  // 2. Les instances qui utilisent cette connexion passent en pause.
  const fournisseur = await p.fournisseurDe(d.tenantId, d.connexionId).catch(() => "imap" as Fournisseur);
  await p.mettreEnPause(d.tenantId, d.connexionId, acteur);
  const jetons = cheminJetons(d.tenantId, d.connexionId);
  // 3. Chez le fournisseur : Google seulement. Microsoft n'a pas de révocation par jeton (l'effacement au coffre révoque ; l'accès restant expire seul).
  // Un échec ici n'arrête rien.
  if (fournisseur === "google") {
    try {
      const jeton = await p.lireJeton(jetons);
      if (jeton) await p.fetch(REVOCATION_GOOGLE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${jeton}` });
    } catch { /* la révocation chez le fournisseur est facultative */ }
  }
  // 4. Effacement de la valeur : jamais avalé en silence.
  let effacement: "fait" | "a_refaire" = "fait";
  try {
    await p.effacerValeur([jetons, `clients/${d.tenantId}/connexions/${d.connexionId}/application`]);
  } catch {
    effacement = "a_refaire";
    p.alerter("effacement_a_refaire", { tenantId: d.tenantId, connexionId: d.connexionId });
  }
  // 5. Trace (sans acteur : le journal du courtier n'en porte pas, l'auteur est dans le journal d'audit de la base).
  p.journal.tracer({ evenement: "connexion_revoquee", tenantId: d.tenantId, connexionId: d.connexionId, code: effacement === "fait" ? "ok" : "effacement_a_refaire" });
  return { etat: "revoquee", effacement };
}
