import { adresseAutorisation as adresseGoogle, echanger as echangerGoogle, type ApplicationGoogle, type ConfigGoogle } from "./oauth-google-interne.js";
import { adresseAccordAdmin, adresseAutorisation as adresseMicrosoft, echanger as echangerMicrosoft, type ConfigMicrosoft, type JetonsRecus } from "./oauth-microsoft.js";
import { ouvrirLien, type PortsLien, type SessionPortail } from "./lien.js";
import { testerConnexion } from "./tester.js";
import { ErreurConnexion, type CodeConnexion, type Transaction, type TransactionsOAuth } from "./transactions.js";

// Ports : tout ce qui touche le coffre, la base ou la configuration est injecté (rien n'est branché ici, D1 → T4-43).
export interface JournalConnexion { tracer(evenement: { evenement?: string; tenantId?: string; connexionId?: string; code?: string }): void }
export interface PortsRappel extends PortsLien {
  transactions: TransactionsOAuth;
  fetch: typeof fetch;
  microsoft: ConfigMicrosoft;
  google: ConfigGoogle;
  lireApplication(tenantId: string, connexionId: string): Promise<ApplicationGoogle>;
  // Réclamation atomique : vraie une seule fois (UPDATE conditionnel en base).
  reclamer(tenantId: string, connexionId: string): Promise<boolean>;
  ecrireCoffre(chemin: string, valeur: Record<string, string | number>): Promise<void>;
  marquerEtat(tenantId: string, connexionId: string, etat: "active" | "en_echec", code?: string): Promise<void>;
  journal: JournalConnexion;
  delaiTestMs?: number;
}
export interface RequeteRappel { state?: unknown; code?: unknown; error?: unknown; tenant?: unknown; admin_consent?: unknown }
export type ReponseRappel =
  | { etat: "active" }
  | { etat: "en_echec"; code: string }
  | { etat: "refuse"; code: CodeConnexion }
  | { etat: "suite"; code: "accord_admin_requis" | "accord_admin_donne"; adresse: string };

const chemin = (t: string, c: string, pieces: "jetons" | "compte"): string => `clients/${t}/connexions/${c}/${pieces}`;
const chaine = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 2048 ? v : undefined);

export async function demarrerAutorisation(p: PortsRappel, jeton: string, session: SessionPortail | null): Promise<{ ok: true; adresse: string } | { ok: false; code: CodeConnexion }> {
  const ouverture = await ouvrirLien(p, jeton, session);
  if (!ouverture.ok || !session) return ouverture.ok ? { ok: false, code: "lien_invalide" } : ouverture;
  const { charge } = ouverture;
  const base = { sujet: session.sujet, tenantId: charge.t, connexionId: charge.c, outil: charge.o, genre: "autorisation" } as const;
  if (charge.o === "microsoft-365") {
    const tx = await p.transactions.creer({ ...base, fournisseur: "microsoft", ...(charge.l ? { locataire: charge.l } : {}) });
    return { ok: true, adresse: adresseMicrosoft(tx, p.microsoft) };
  }
  if (charge.o === "gmail" && charge.d) {
    const app = await p.lireApplication(charge.t, charge.c).catch(() => null);
    if (!app) return { ok: false, code: "application_inconnue" };
    const tx = await p.transactions.creer({ ...base, fournisseur: "google", domaine: charge.d });
    return { ok: true, adresse: adresseGoogle(tx, app, p.google) };
  }
  return { ok: false, code: charge.o === "imap" ? "outil_non_oauth" : "lien_invalide" };
}

export async function terminerRappel(p: PortsRappel, session: SessionPortail | null, requete: RequeteRappel): Promise<ReponseRappel> {
  const refus = (code: CodeConnexion, tx?: Transaction): ReponseRappel => {
    p.journal.tracer({ evenement: "connexion_refusee", code, ...(tx ? { tenantId: tx.tenantId, connexionId: tx.connexionId } : {}) });
    return { etat: "refuse", code };
  };
  // 1. state inconnu, modifié ou déjà utilisé : aucun appel au fournisseur.
  const state = chaine(requete.state);
  const tx = state ? await p.transactions.prendre(state) : null;
  if (!tx) return refus("etat_inconnu");
  // 2. même personne, même client : sinon la transaction est déjà brûlée.
  if (!session || session.sujet !== tx.sujet || session.tenantId !== tx.tenantId) return refus("autre_session", tx);
  // 3.
  if (tx.echeance < p.maintenant()) return refus("transaction_echue", tx);
  const suite = async (genre: Transaction["genre"], code: "accord_admin_requis" | "accord_admin_donne"): Promise<ReponseRappel> => {
    const { state: _s, verifier: _v, nonce: _n, echeance: _e, ...base } = tx;
    const nouvelle = await p.transactions.creer({ ...base, genre });
    return { etat: "suite", code, adresse: genre === "accord_admin" ? adresseAccordAdmin(nouvelle, p.microsoft) : adresseMicrosoft(nouvelle, p.microsoft) };
  };
  // 4 et 5. Accord de l'administrateur (jamais de texte du fournisseur recopié).
  if (tx.genre === "accord_admin") {
    if (requete.error !== undefined) return refus("refus_fournisseur", tx);
    if (chaine(requete.tenant)?.toLowerCase() !== tx.locataire?.toLowerCase()) return refus("mauvais_compte", tx);
    return suite("autorisation", "accord_admin_donne");
  }
  if (requete.error !== undefined) {
    return tx.fournisseur === "microsoft" && requete.error === "consent_required" ? suite("accord_admin", "accord_admin_requis") : refus("refus_fournisseur", tx);
  }
  // 6. Échange puis contrôle du locataire (dans l'échange).
  const code = chaine(requete.code);
  if (!code) return refus("refus_fournisseur", tx);
  let jetons: JetonsRecus;
  try {
    if (tx.fournisseur === "microsoft") jetons = await echangerMicrosoft(p.fetch, tx, code, p.microsoft);
    else jetons = await echangerGoogle(p.fetch, tx, code, await p.lireApplication(tx.tenantId, tx.connexionId), p.google);
  } catch (e) {
    const c = e instanceof ErreurConnexion ? e.code : "refus_fournisseur";
    if (c === "accord_admin_requis" && tx.fournisseur === "microsoft") return suite("accord_admin", "accord_admin_requis");
    return refus(c, tx);
  }
  // 7. Réclamation atomique AVANT toute écriture au coffre : les jetons du perdant sont oubliés.
  if (!(await p.reclamer(tx.tenantId, tx.connexionId).catch(() => false))) return refus("deja_utilise", tx);
  // 8. Jetons directement au coffre, puis la pièce non secrète du compte relié.
  const maintenantS = Math.floor(p.maintenant() / 1000);
  try {
    await p.ecrireCoffre(chemin(tx.tenantId, tx.connexionId, "jetons"), { access_token: jetons.access_token, refresh_token: jetons.refresh_token, expires_at: maintenantS + jetons.expires_in, duree_s: jetons.expires_in });
    await p.ecrireCoffre(chemin(tx.tenantId, tx.connexionId, "compte"), { fournisseur: tx.fournisseur, ...jetons.compte });
  } catch {
    await p.marquerEtat(tx.tenantId, tx.connexionId, "en_echec", "ecriture_echouee");
    p.journal.tracer({ evenement: "connexion_refusee", tenantId: tx.tenantId, connexionId: tx.connexionId, code: "ecriture_echouee" });
    return { etat: "en_echec", code: "ecriture_echouee" };
  }
  // 9. Test immédiat, lecture sans effet.
  const test = await testerConnexion({ fetch: p.fetch, ...(p.delaiTestMs !== undefined ? { delaiMs: p.delaiTestMs } : {}), ...(p.microsoft.hoteApi ? { hoteMicrosoft: p.microsoft.hoteApi } : {}), ...(p.google.hoteApi ? { hoteGoogle: p.google.hoteApi } : {}) }, tx.fournisseur, jetons.access_token);
  if (test.ok) {
    await p.marquerEtat(tx.tenantId, tx.connexionId, "active");
    p.journal.tracer({ evenement: "connexion_reliee", tenantId: tx.tenantId, connexionId: tx.connexionId });
    return { etat: "active" };
  }
  await p.marquerEtat(tx.tenantId, tx.connexionId, "en_echec", test.code);
  p.journal.tracer({ evenement: "connexion_refusee", tenantId: tx.tenantId, connexionId: tx.connexionId, code: test.code });
  return { etat: "en_echec", code: test.code };
}
