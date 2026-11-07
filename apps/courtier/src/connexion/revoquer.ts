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
  // Délai d'abandon de l'appel à Google (millisecondes ; 5 000 par défaut).
  delaiGoogleMs?: number;
  journal: { tracer(evenement: Record<string, string>): void };
}
export interface DemandeRevocation { tenantId: string; connexionId: string; acteur: string; motif: string }
export type ResultatRevocation =
  | { etat: "revoquee"; effacement: "fait" | "a_refaire" }
  | { etat: "deja_revoquee" | "inconnue" | "refusee" };

const MOTIFS = ["demande_client", "decision_dirigeant"];
const REVOCATION_GOOGLE = "https://oauth2.googleapis.com/revoke";

async function appelerGoogle(p: PortsRevocation, jeton: string): Promise<void> {
  const signal = AbortSignal.timeout(p.delaiGoogleMs ?? 5000);
  const abandon = new Promise<never>((_, rejeter) => signal.addEventListener("abort", () => rejeter(new Error("delai")), { once: true }));
  const appel = p.fetch(REVOCATION_GOOGLE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: jeton }).toString(), signal });
  appel.catch(() => {});
  await Promise.race([appel, abandon]);
}

export async function revoquerConnexion(p: PortsRevocation, d: DemandeRevocation): Promise<ResultatRevocation> {
  const acteur = typeof d.acteur === "string" ? d.acteur.trim() : "";
  if (!MOTIFS.includes(d.motif) || acteur === "" || acteur.toLowerCase() === "systeme") return { etat: "refusee" };
  if (!(await p.existe(d.tenantId, d.connexionId))) return { etat: "inconnue" };
  // 1. La base d'abord : définitive. Zéro ligne : déjà révoquée, rien d'autre ne se passe.
  if (!(await p.marquerRevoquee(d.tenantId, d.connexionId, acteur, d.motif))) return { etat: "deja_revoquee" };
  // Chaque étape suivante est isolée : la base est déjà définitive, donc rien ne doit empêcher l'effacement, l'alerte et la trace.
  // Les erreurs sont journalisées par leur nom d'étape seulement (jamais de message, qui pourrait porter un secret) ; la première est relevée à la fin.
  let premiere: unknown;
  let incomplet: string | undefined;
  const rater = (code: string, e: unknown) => {
    incomplet ??= code;
    premiere ??= e;
    p.journal.tracer({ evenement: "revocation_etape_echouee", tenantId: d.tenantId, connexionId: d.connexionId, code });
  };
  // 2. Les instances qui utilisent cette connexion passent en pause.
  let fournisseur: Fournisseur | undefined;
  try { fournisseur = await p.fournisseurDe(d.tenantId, d.connexionId); } catch (e) { rater("fournisseur_inconnu", e); }
  try { await p.mettreEnPause(d.tenantId, d.connexionId, acteur); } catch (e) { rater("pause_echouee", e); }
  const jetons = cheminJetons(d.tenantId, d.connexionId);
  // 3. Chez le fournisseur : Google seulement. Microsoft n'a pas de révocation par jeton (l'effacement au coffre révoque ; l'accès restant expire seul).
  // Un échec ou un silence ici n'arrête rien (délai d'abandon).
  if (fournisseur === "google") {
    try {
      const jeton = await p.lireJeton(jetons);
      if (jeton) await appelerGoogle(p, jeton);
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
  if (incomplet) p.alerter("revocation_incomplete", { tenantId: d.tenantId, connexionId: d.connexionId });
  // 5. Trace (sans acteur : le journal du courtier n'en porte pas, l'auteur est dans le journal d'audit de la base).
  try {
    p.journal.tracer({ evenement: "connexion_revoquee", tenantId: d.tenantId, connexionId: d.connexionId, code: incomplet ?? (effacement === "fait" ? "ok" : "effacement_a_refaire") });
  } catch (e) { premiere ??= e; }
  if (premiere !== undefined) throw premiere;
  return { etat: "revoquee", effacement };
}
