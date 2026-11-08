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
