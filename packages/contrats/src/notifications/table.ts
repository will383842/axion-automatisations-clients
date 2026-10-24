// Table unique des envois automatiques (C-557) : aucun écran n'envoie un message absent d'ici.
// E-mail seulement en V1 ; le téléphone viendra en V2. Aucun envoi commercial automatique.

export type Destinataire = "administrateur_client" | "collegue_invite" | "will";
export type ModeEnvoi = "automatique" | "clic_will";

export interface Envoi {
  evenement: string;
  destinataire: Destinataire;
  canal: "email";
  mode: ModeEnvoi;
  interrupteur: string;
  // Clé dans messages.fr.ts ; null tant que le catalogue n'a pas le texte de l'e-mail.
  cleTexte: string | null;
  version: "V1" | "V2";
  exigence: string;
  // Conditions à vérifier juste avant l'envoi.
  conditions?: string[];
}

const e = (
  evenement: string,
  destinataire: Destinataire,
  mode: ModeEnvoi,
  exigence: string,
  cleTexte: string | null = null,
  conditions?: string[],
): Envoi => ({
  evenement,
  destinataire,
  canal: "email",
  mode,
  interrupteur: `envoi.${evenement}`,
  cleTexte,
  version: "V1",
  exigence,
  ...(conditions ? { conditions } : {}),
});

export const TABLE_ENVOIS: readonly Envoi[] = [
  e("invitationPortail", "administrateur_client", "automatique", "C-557"),
  e("invitationCollegue", "collegue_invite", "automatique", "C-557"),
  e("cestParti", "administrateur_client", "automatique", "C-557, C-580"),
  e("lancementEnCours", "administrateur_client", "automatique", "C-557, C-580", "vide.portail.accueilAvantLancement"),
  e("lienReconnexion", "administrateur_client", "automatique", "C-577, C-603", null, [
    "connexionTesteeEnEchec",
    "aucunIncidentOuvertSurConnecteur",
  ]),
  e("avisExpirationConnexion7Jours", "administrateur_client", "automatique", "C-557"),
  e("brouillonEnAttente", "administrateur_client", "automatique", "C-564"),
  e("brouillonExpire", "administrateur_client", "automatique", "C-564", "erreur.brouillonExpire"),
  e("envoiEnAttenteARelire", "administrateur_client", "automatique", "C-605"),
  e("palier80Client", "administrateur_client", "automatique", "C-614"),
  e("palier100Client", "administrateur_client", "automatique", "C-557, C-614"),
  e("palier80Will", "will", "automatique", "C-614"),
  e("palier100Will", "will", "automatique", "C-614"),
  e("factureDisponible", "administrateur_client", "automatique", "C-557"),
  e("relanceImpaye", "administrateur_client", "clic_will", "C-557"),
  e("nonPaiement30Jours", "administrateur_client", "clic_will", "C-558"),
  e("rapportMensuel", "administrateur_client", "automatique", "C-571"),
  e("notificationViolation", "administrateur_client", "clic_will", "C-557, C-617"),
];
