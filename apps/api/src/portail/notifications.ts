import { randomUUID } from "node:crypto";

// Préférences de notification par e-mail (B-186). Partie pure : listes fermées, clé stockée, décision de lire les préférences.
// Aucune route, aucun SQL ici. E-mail seulement en V1 : aucun autre canal n'est importé.

// Messages de service (C-097) : jamais coupés par une préférence, et ne lisent jamais les préférences.
export const NON_DESACTIVABLES: readonly string[] = [
  "invitationPortail",
  "invitationCollegue",
  "lienReconnexion",
  "avisExpirationConnexion7Jours",
  "palier80Client",
  "palier100Client",
  "factureDisponible",
  "relanceImpaye",
  "nonPaiement30Jours",
  "notificationViolation",
];
// Classement par défaut proposé (décision D3 de Will en attente).
export const DESACTIVABLES: readonly string[] = ["cestParti", "lancementEnCours", "brouillonEnAttente", "brouillonExpire", "envoiEnAttenteARelire", "rapportMensuel"];

// Ligne réservée du choix « résumé hebdomadaire » dans preferences_notifications.
export const CLE_RESUME_HEBDOMADAIRE = "resume_hebdomadaire";

export interface PreferencesEnvoi {
  // Vrai si l'utilisateur a coupé cet envoi. Une erreur lancée = lecture en échec = pas d'envoi.
  coupee(tenantId: string, utilisateur: string, evenement: string): Promise<boolean>;
}

export function doitLirePreferences(evenement: string): boolean {
  return DESACTIVABLES.includes(evenement);
}

// camelCase -> minuscules séparées par « _ » (contrainte preferences_notifications_cle_code de 0025).
export function cleStockee(evenement: string): string {
  const cle = evenement.replace(/([A-Z])/g, "_$1").toLowerCase();
  if (cle === CLE_RESUME_HEBDOMADAIRE || !/^[a-z0-9_.-]+$/.test(cle)) throw new Error("événement sans clé stockable");
  return cle;
}

// Accès SQL (à appeler dans la transaction d'avecClient : client fixé, app.acteur posé). Le client ET l'utilisateur filtrent toujours.
export type Requeteur = { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> };
export interface PreferencesLues { desactivees: string[]; resumeHebdomadaire: boolean }
export class PreferenceRefusee extends Error {}

export async function lirePreferences(c: Requeteur, tenantId: string, utilisateur: string): Promise<PreferencesLues> {
  const { rows } = await c.query("SELECT cle_envoi, activee, resume_hebdomadaire FROM preferences_notifications WHERE tenant_id = $1 AND utilisateur = $2", [tenantId, utilisateur]);
  const parCle = new Map(DESACTIVABLES.map((ev) => [cleStockee(ev), ev]));
  const desactivees = rows.filter((r) => r["activee"] === false && parCle.has(String(r["cle_envoi"]))).map((r) => parCle.get(String(r["cle_envoi"])) as string);
  const resumeHebdomadaire = rows.some((r) => r["cle_envoi"] === CLE_RESUME_HEBDOMADAIRE && r["resume_hebdomadaire"] === true);
  return { desactivees, resumeHebdomadaire };
}

export async function ecrirePreference(c: Requeteur, tenantId: string, utilisateur: string, evenement: string, activee: boolean): Promise<void> {
  if (!DESACTIVABLES.includes(evenement)) throw new PreferenceRefusee("envoi non désactivable");
  await c.query(
    "INSERT INTO preferences_notifications (tenant_id, id, utilisateur, cle_envoi, activee) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, utilisateur, cle_envoi) DO UPDATE SET activee = EXCLUDED.activee, maj_le = now()",
    [tenantId, randomUUID(), utilisateur, cleStockee(evenement), activee],
  );
}

export async function ecrireResume(c: Requeteur, tenantId: string, utilisateur: string, valeur: boolean): Promise<void> {
  await c.query(
    "INSERT INTO preferences_notifications (tenant_id, id, utilisateur, cle_envoi, resume_hebdomadaire) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, utilisateur, cle_envoi) DO UPDATE SET resume_hebdomadaire = EXCLUDED.resume_hebdomadaire, maj_le = now()",
    [tenantId, randomUUID(), utilisateur, CLE_RESUME_HEBDOMADAIRE, valeur],
  );
}
